/**
 * @fileoverview One backup, several services: the mirror backend.
 *
 * A page that wants its backup on Aleph *and* on Lighthouse had to call both
 * and reconcile two handles itself. This does that once, behind the same
 * contract every other driver keeps, so `dehydrate`, `backupDatabaseCAR` and
 * `restoreFromCID` need to know nothing about it.
 *
 * ## What a mirror promises, and what it refuses to
 *
 * **A partial write is reported, never swallowed.** By default a write
 * succeeds when at least one service took it — a backup that fails because the
 * third service was down would be worse than useless — but the handle then
 * names who holds it and who refused, and the caller decides what to say. Pass
 * `require: "all"` when a copy everywhere is the point of the exercise.
 *
 * **A read asks in order and stops at the first answer.** Not a race: a race
 * spends every service's bandwidth on every read, and on a gateway that bills
 * by request that is somebody's money. The order is the order the backends
 * were given, so "the fast one first" is the caller's decision to make.
 *
 * **Capabilities are the honest composition, not the flattering one.**
 * `browserSafeAuth` is true only when *every* service is safe to hand a page,
 * because the weakest one decides what a page leaks. `preservesInnerCids` and
 * `carImport` likewise. `minBlobSize` is the largest of them, because a blob
 * has to clear the strictest door. `pinByCid` is the exception: it is true when
 * *any* service can pin, and `pinCid()` then asks exactly those.
 *
 * **It does not list and it does not delete.** Both questions have no single
 * honest answer across services — a listing would be a union with duplicates,
 * and a deletion that half succeeds leaves a copy behind while reporting
 * success. A caller that wants either can ask the service it means.
 *
 * @author @NiKrause
 * @requires ./types.js - the contract this keeps
 */

import {
  defineBackend,
  handleId,
  BackendError,
  DEFAULT_CAPABILITIES,
} from "./types.js";
import { logger } from "../logger.js";

/** The strictest door decides; an unstated minimum is no minimum. */
const largestMinimum = (backends) =>
  backends.reduce(
    (largest, backend) =>
      Math.max(largest, backend.capabilities?.minBlobSize ?? 0),
    0,
  );

const everyOne = (backends, flag) =>
  backends.every((backend) => Boolean(backend.capabilities?.[flag]));
const anyOne = (backends, flag) =>
  backends.some((backend) => Boolean(backend.capabilities?.[flag]));

/**
 * Write one backup to several services and read it back from whichever answers.
 *
 * @param {import("./types.js").StorageBackend[]} backends - two or more drivers,
 *   in the order reads should try them
 * @param {object} [options]
 * @param {"one"|"all"} [options.require="one"] - how many services must accept a
 *   write for it to count as one
 * @param {string} [options.name] - what the mirror calls itself; the default
 *   names its members, because a log line saying "mirror" says nothing
 * @returns {import("./types.js").StorageBackend}
 */
export function createMirrorBackend(backends = [], options = {}) {
  const members = backends.filter(Boolean);
  if (members.length < 2) {
    throw new BackendError(
      "INVALID_BACKEND",
      "createMirrorBackend needs at least two backends; one backend is not a mirror",
    );
  }

  const require_ = options.require ?? "one";
  if (require_ !== "one" && require_ !== "all") {
    throw new BackendError(
      "INVALID_BACKEND",
      `require must be "one" or "all", not ${require_}`,
    );
  }

  const name =
    options.name ||
    `mirror(${members.map((backend) => backend.name).join("+")})`;
  const pinners = members.filter(
    (backend) => typeof backend.pinCid === "function",
  );

  /** Run one operation against every member, keeping which of them said what. */
  const acrossAll = async (operation) => {
    const settled = await Promise.allSettled(
      members.map((backend) => operation(backend)),
    );
    const copies = [];
    const failures = [];
    settled.forEach((result, index) => {
      const backend = members[index];
      if (result.status === "fulfilled") {
        copies.push({ backend: backend.name, ...result.value });
      } else {
        failures.push({
          backend: backend.name,
          code: result.reason?.code ?? "FAILED",
          message: result.reason?.message ?? String(result.reason),
        });
      }
    });
    return { copies, failures };
  };

  /**
   * One handle for the copies. The id is the CID when every service agreed on
   * one — which is the normal case, since the bytes decide it — and the first
   * success otherwise, so a handle is always usable somewhere.
   */
  const mergeHandles = ({ copies, failures }, what) => {
    if (copies.length === 0) {
      throw new BackendError(
        failures[0]?.code === "TOO_SMALL" ? "TOO_SMALL" : "FAILED",
        `${name}: no service accepted ${what} — ${failures
          .map((failure) => `${failure.backend}: ${failure.message}`)
          .join("; ")}`,
      );
    }
    if (require_ === "all" && failures.length > 0) {
      throw new BackendError(
        "FAILED",
        `${name}: ${failures.length} of ${members.length} services refused ${what} and require is "all" — ${failures
          .map((failure) => `${failure.backend}: ${failure.message}`)
          .join("; ")}`,
      );
    }
    if (failures.length > 0) {
      logger.warn(
        `⚠️  ${name}: ${copies.length} of ${members.length} services hold ${what}; ` +
          failures
            .map((failure) => `${failure.backend} refused (${failure.code})`)
            .join(", "),
      );
    }

    const cids = new Set(copies.map((copy) => copy.cid).filter(Boolean));
    const agreed = cids.size === 1 ? [...cids][0] : null;
    return {
      id: agreed ?? copies[0].id,
      ...(agreed ? { cid: agreed } : {}),
      backend: name,
      ...(copies[0].size != null ? { size: copies[0].size } : {}),
      ...(copies[0].name ? { name: copies[0].name } : {}),
      copies,
      ...(failures.length > 0 ? { failures } : {}),
    };
  };

  /** A member's own id for this handle, since only the CID is shared. */
  const idFor = (backend, handle) => {
    const copy =
      typeof handle === "object" && handle?.copies
        ? handle.copies.find((entry) => entry.backend === backend.name)
        : null;
    return copy?.id ?? handleId(handle);
  };

  const mirror = {
    name,
    /** The members, in read order — a caller that wants one service can reach it. */
    backends: members,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      pinByCid: pinners.length > 0 && anyOne(members, "pinByCid"),
      carImport: everyOne(members, "carImport"),
      preservesInnerCids: everyOne(members, "preservesInnerCids"),
      browserSafeAuth: everyOne(members, "browserSafeAuth"),
      delegation: everyOne(members, "delegation"),
      listing: false,
      deletion: false,
      minBlobSize: largestMinimum(members),
    },

    putBlob: async (bytes, meta = {}) =>
      mergeHandles(
        await acrossAll((backend) => backend.putBlob(bytes, meta)),
        "the blob",
      ),

    getBlob: async (handle) => {
      const reasons = [];
      for (const backend of members) {
        try {
          return await backend.getBlob(idFor(backend, handle));
        } catch (error) {
          reasons.push(`${backend.name}: ${error?.message ?? error}`);
        }
      }
      throw new BackendError(
        "NOT_FOUND",
        `${name}: no service returned ${handleId(handle)} — ${reasons.join("; ")}`,
      );
    },
  };

  if (mirror.capabilities.pinByCid) {
    /** Only the services that can pin are asked; the others have nothing to say. */
    mirror.pinCid = async (cid, meta = {}) => {
      const settled = await Promise.allSettled(
        pinners.map((backend) => backend.pinCid(cid, meta)),
      );
      const copies = [];
      const failures = [];
      settled.forEach((result, index) => {
        const backend = pinners[index];
        if (result.status === "fulfilled")
          copies.push({ backend: backend.name, ...result.value });
        else
          failures.push({
            backend: backend.name,
            code: result.reason?.code ?? "FAILED",
            message: result.reason?.message ?? String(result.reason),
          });
      });
      return mergeHandles({ copies, failures }, `the pin for ${cid}`);
    };
  }

  return defineBackend(mirror);
}

export default createMirrorBackend;
