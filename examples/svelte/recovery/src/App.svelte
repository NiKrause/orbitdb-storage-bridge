<!-- SPDX-License-Identifier: MIT -->
<script>
  /**
   * P11 on two phones: a list, a security key, and a device that has lost
   * everything.
   *
   * Seven steps, in the order the test runs them, and each says what it
   * proved rather than only that it worked. The numbers on screen — the DID
   * fingerprint above all — are what the two phones are compared by: if they
   * differ, nothing that follows means anything, and the page says so.
   */
  import { onMount } from "svelte";
  import { lang } from "./ui.js";
  import { WORDS } from "./words.js";
  import {
    identityFromKey,
    createStack,
    createList,
    backUp,
    bringBack,
    backendFor,
    SERVICES,
    FETCH_PATHS,
    forgetEverything,
  } from "./stack.js";

  const build = __BUILD_INFO__;

  let identity = $state(null); // { did, signingKey, credential }
  let stack = $state(null);
  let db = $state(null);
  let entries = $state([]);
  let pointer = $state(null); // what the last backup published
  let newText = $state("");
  let busy = $state(""); // which step is running
  let error = $state("");
  let touches = $state("");
  let log = $state([]);
  // Which way each object came back, and how long it took. `null` means the
  // path was not used; a string means it failed and why.
  let delivery = $state({ gateway: null, peers: null, peerCount: 0 });

  /**
   * Where the backup goes, and what it takes to put it there.
   *
   * Aleph needs nothing and is on by default, which is what keeps this page
   * usable with no account at all. A key typed in for one of the others stays
   * in this browser's localStorage and is sent to that service and nowhere
   * else — this page has no server to send it to.
   */
  const SERVICE_STORE = "recovery:services";
  const loadServices = () => {
    try {
      const kept = JSON.parse(localStorage.getItem(SERVICE_STORE) ?? "null");
      if (Array.isArray(kept) && kept.length > 0) return kept;
    } catch {
      // Blocked storage or a private window: the default is fine.
    }
    return [{ id: "aleph" }];
  };
  let services = $state(loadServices());
  const keepServices = () => {
    try {
      localStorage.setItem(SERVICE_STORE, JSON.stringify(services));
    } catch {
      // Nothing to do: the choice still holds for this visit.
    }
  };

  const chosen = (id) => services.some((s) => s.id === id);
  const detail = (id, field) => services.find((s) => s.id === id)?.[field] ?? "";
  const toggleService = (id) => {
    services = chosen(id) ? services.filter((s) => s.id !== id) : [...services, { id }];
    keepServices();
  };
  const setDetail = (id, field, value) => {
    services = services.map((s) => (s.id === id ? { ...s, [field]: value.trim() } : s));
    keepServices();
  };
  const forgetKeys = () => {
    services = [{ id: "aleph" }];
    try {
      localStorage.removeItem(SERVICE_STORE);
    } catch {
      // As above.
    }
  };

  /** What is missing before a backup can be written, in the reader's words. */
  const missing = $derived(
    services
      .map((s) => {
        const known = SERVICES.find((k) => k.id === s.id);
        if (!known?.needsKey || s.key) return null;
        return t.services[s.id];
      })
      .filter(Boolean),
  );

  /**
   * `?fetch=gateway|p2p|race` forces one path, for a run that wants to measure
   * it alone. Anything else, including nothing, is the default: gateway first,
   * peers behind it.
   */
  const fetchPath = (() => {
    const asked = new URLSearchParams(location.search).get("fetch");
    return FETCH_PATHS.includes(asked) ? asked : "first";
  })();
  let details = $state(false); // the technical layer, behind one button
  let done = $state({}); // step name → true once it has worked
  let failedStep = $state("");

  // The page's words in its current language; a log line takes the language of
  // the moment it was written.
  const t = $derived(WORDS[$lang]);
  const w = () => WORDS[lang.get()];
  $effect(() => {
    document.title = t.title;
  });

  const status = (name) =>
    busy === name ? "running" : failedStep === name ? "failed" : done[name] ? "done" : "todo";

  const say = (line) =>
    (log = [`${new Date().toISOString().slice(11, 19)} ${line}`, ...log].slice(0, 40));

  /** Eight bytes of a hash, in pairs — enough to compare two phones by eye. */
  async function fingerprint(value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest.slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/(.{4})/g, "$1 ")
      .trim();
  }

  let didFingerprint = $state("");
  let keyFingerprint = $state("");

  const refresh = async () => {
    entries = db ? (await db.all()).map((entry) => entry.value) : [];
  };

  async function step(name, work) {
    if (busy) return;
    busy = name;
    error = "";
    failedStep = "";
    try {
      await work();
      done = { ...done, [name]: true };
    } catch (e) {
      error = e?.message ?? String(e);
      failedStep = name;
      say(w().log.failed(name, error));
    } finally {
      busy = "";
      touches = "";
    }
  }

  const useTheKey = () =>
    step("key", async () => {
      say(w().log.asking);
      identity = await identityFromKey({
        onTouch: ({ touch }) => {
          touches = w().touch[touch];
          say(w().touch[touch]);
        },
      });
      didFingerprint = await fingerprint(identity.did);
      keyFingerprint = await fingerprint(identity.signingKey);
      say(w().log.identity(identity.did.slice(0, 24)));
      touches = w().touch[3];
      say(w().touch[3]);
      stack = await createStack({ credential: identity.credential });
      say(w().log.running);
    });

  const makeList = () =>
    step("list", async () => {
      db = await createList({ orbitdb: stack.orbitdb, identity: stack.identity });
      say(w().log.listOpen(db.address));
      await refresh();
    });

  const add = () =>
    step("add", async () => {
      const text = newText.trim();
      if (!text) return;
      await db.add(text);
      newText = "";
      say(w().log.wrote(text));
      await refresh();
    });

  const dehydrateNow = () =>
    step("backup", async () => {
      say(w().log.backingUp);
      pointer = await backUp({
        orbitdb: stack.orbitdb,
        address: db.address,
        signingKey: identity.signingKey,
        services,
      });
      say(w().log.published(pointer.name, pointer.metadataCID, pointer.blocks));
    });

  const hydrateNow = () =>
    step("restore", async () => {
      say(w().log.askingPointer);
      delivery = { gateway: null, peers: null, peerCount: 0 };
      const found = await bringBack({
        orbitdb: stack.orbitdb,
        helia: stack.helia,
        signingKey: identity.signingKey,
        services,
        path: fetchPath,
        onPath: (which, info) => {
          const ms = `${info.ms} ms`;
          if (which === "gateway") {
            delivery = { ...delivery, gateway: ms };
            say(w().log.viaGateway(ms, info.bytes));
          } else {
            delivery = {
              ...delivery,
              peers: ms,
              peerCount: info.connections ?? delivery.peerCount,
              gateway: delivery.gateway ?? (info.after?.error || w().log.gatewaySilent),
            };
            say(w().log.viaPeers(ms, info.bytes, info.connections ?? 0));
          }
        },
      });
      db = found.db;
      pointer = { name: found.name, metadataCID: found.metadataCID, blocks: found.blocks };
      say(w().log.restored(found.address, found.blocks));
      await refresh();
    });

  const forget = () =>
    step("forget", async () => {
      await forgetEverything();
      say(w().log.gone);
      setTimeout(() => location.reload(), 600);
    });

  onMount(() => {
    say(w().log.nothingStored);
  });
</script>

<main>
  <h1>recovery</h1>
  {#if $lang === "de"}
    <p class="tag">Eine Liste, die den Verlust des Telefons übersteht — mit nichts als dem Sicherheitsschlüssel.</p>
  {:else}
    <p class="tag">A list that survives losing the phone — with nothing but your security key.</p>
  {/if}

  <section class="intro">
    {#if $lang === "de"}
      <p>
        Ein Sicherheitsschlüssel hält ein Geheimnis, das ihn nie verlässt. Aus diesem Geheimnis
        leitet die Seite die Identität ab und den Ort der Sicherung — auf jedem Telefon dieselben.
        Ein Telefon, das alles verloren hat, oder ein neues braucht deshalb nur den Schlüssel, um
        die Liste wiederzufinden und weiter hineinzuschreiben.
      </p>
      <h2>Der Test, auf zwei Telefonen</h2>
      <ol class="plan">
        <li><strong>Telefon A:</strong> Schritte 1, 2 und 3 — Identität, Liste, Sicherung.</li>
        <li>
          <strong>Telefon B</strong> oder Telefon A nach Schritt 4: Schritt 1 mit demselben
          Schlüssel, dann Schritt 5.
        </li>
        <li>
          <strong>Gelungen</strong> ist es, wenn die Liste auf Telefon B zurückkommt und dort einen
          neuen Eintrag annimmt.
        </li>
      </ol>
    {:else}
      <p>
        Your security key holds a secret that never leaves it. From that secret this page works
        out who you are and where your backup lives — the same on every phone. So a phone that
        has lost everything, or a new one, needs nothing but the key to find the list again and
        go on writing to it.
      </p>
      <h2>The test, on two phones</h2>
      <ol class="plan">
        <li><strong>Phone A:</strong> steps 1, 2 and 3 — who you are, a list, a backup.</li>
        <li>
          <strong>Phone B</strong>, or phone A after step 4: step 1 with the same key, then step 5.
        </li>
        <li>
          <strong>It worked</strong> if the list comes back on phone B and accepts a new entry
          there.
        </li>
      </ol>
    {/if}
    <button
      class="ghost"
      data-testid="details"
      aria-expanded={details}
      onclick={() => (details = !details)}
    >
      {details ? t.hideDetails : t.showDetails}
    </button>

    <div class="tech explain" data-testid="how-it-works" hidden={!details}>
      {#if $lang === "de"}
        <h3>Die drei Berührungen in Schritt 1</h3>
        <ol>
          <li>
            <strong>Das Geheimnis.</strong> <code>navigator.credentials.get()</code> nennt keinen
            Credential — der Schlüssel bietet seinen Passkey für diese Seite an — und fragt die
            PRF-Erweiterung mit einer festen Eingabe: SHA-256 aus einem Label und dem Namen dieser
            Seite, auf jedem Telefon gleich. Der Schlüssel antwortet mit der Credential-ID, einer
            Signatur und einer 32-Byte-PRF-Ausgabe, berechnet im Schlüssel aus einem Geheimnis, das
            ihn nie verlässt. Mit PIN, weil der Schlüssel ohne PIN eine andere PRF-Antwort gibt.
          </li>
          <li>
            <strong>Der öffentliche Schlüssel.</strong> Eine WebAuthn-Antwort enthält keinen
            öffentlichen Schlüssel, also wird er errechnet: Derselbe Credential signiert eine zweite,
            frische Challenge; zu jeder P-256-Signatur passen genau zwei Kandidaten, und nur der
            eigene Schlüssel passt zu beiden. Gegen beide Signaturen geprüft, wird er zur Identität,
            <code>did:key:z…</code>.
          </li>
          <li>
            <strong>Die Bindung.</strong> Eine OrbitDB-Identität trägt zwei Signaturen: Der
            Signierschlüssel signiert die DID, und der Passkey signiert den öffentlichen
            Signierschlüssel zusammen mit dieser Signatur. Die zweite ist ein weiterer
            WebAuthn-Aufruf — der Passkey bürgt dafür, dass dieser Schlüssel in seinem Namen
            schreibt. Jeder Eintrag, den die Liste annimmt, wird dagegen geprüft.
          </li>
        </ol>
        <h3>Abgeleitet, nie gespeichert</h3>
        <ul>
          <li>
            <strong>Signierschlüssel</strong> (secp256k1): HKDF-SHA-256 über die PRF-Ausgabe, mit
            der DID im Info-Feld.
          </li>
          <li>
            <strong>Zeigerschlüssel</strong> (Ed25519): HKDF-SHA-256 über den Signierschlüssel, mit
            dem Label dieser Seite im Info-Feld. Sein öffentlicher Schlüssel ist der Name des
            Zeigers, <code>k51…</code>.
          </li>
        </ul>
        <h3>Jede Anfrage, und wann</h3>
        <ul>
          <li>
            <strong>Schritte 1, 2 und 4:</strong> keine. Das Telefon spricht mit dem Schlüssel über
            USB, NFC oder Bluetooth, nicht über das Internet.
          </li>
          <li>
            <strong>Schritt 3:</strong> <code>POST ipfs.aleph.cloud/api/v0/add</code>, zweimal — die
            Liste als eine CAR-Datei mit allen Blöcken, aus denen sie besteht, dann ein kleines
            JSON, das sie benennt. Danach <code>PUT delegated-ipfs.dev/routing/v1/ipns/k51…</code>:
            ein IPNS-Eintrag, signiert mit dem Zeigerschlüssel, der auf das JSON zeigt, 30 Tage
            gültig.
          </li>
          <li>
            <strong>Schritt 5:</strong> <code>GET delegated-ipfs.dev/routing/v1/ipns/k51…</code>, und
            der Eintrag wird gegen den Namen geprüft. Dann <code>GET ipfs.aleph.cloud/ipfs/…</code>
            für das JSON und die CAR-Datei, und jeder Block wird gegen seinen Hash geprüft, bevor
            die Liste öffnet. Einen zweiten Weg gibt es derzeit nicht: die öffentlichen
            IPFS-Gateways, die früher hier standen, wurden am 21. September 2026 abgeschaltet.
          </li>
        </ul>
        <p class="dim">
          Die Werte eines Schritts erscheinen darunter, sobald er gelaufen ist; was geschah, Zeile
          für Zeile, steht <a href="#log">unten auf der Seite</a>.
        </p>
      {:else}
        <h3>The three touches of step 1</h3>
        <ol>
          <li>
            <strong>The secret.</strong> <code>navigator.credentials.get()</code> names no
            credential — the key offers its passkey for this site — and asks the PRF extension with
            a fixed input: SHA-256 of a label and this site's name, the same on every phone. The
            key answers with the credential id, a signature, and a 32-byte PRF output computed
            inside the key from a secret that never leaves it. With PIN, because the key gives a
            different PRF answer without one.
          </li>
          <li>
            <strong>The public key.</strong> A WebAuthn answer carries no public key, so it is
            worked out: the same credential signs a second, fresh challenge, every P-256 signature
            fits exactly two candidate public keys, and only the key's own fits both. Checked
            against both signatures, it becomes the identity, <code>did:key:z…</code>.
          </li>
          <li>
            <strong>The binding.</strong> An OrbitDB identity carries two signatures: the signing
            key signs the DID, and the passkey signs the signing key's public key together with
            that signature. The second is one more WebAuthn call — the passkey vouching that this
            key writes for it. Every entry the list accepts is checked against it.
          </li>
        </ol>
        <h3>Derived, never stored</h3>
        <ul>
          <li>
            <strong>Signing key</strong> (secp256k1): HKDF-SHA-256 over the PRF output, with the DID
            in the info.
          </li>
          <li>
            <strong>Pointer key</strong> (Ed25519): HKDF-SHA-256 over the signing key, with this
            page's label in the info. Its public key is the pointer's name, <code>k51…</code>.
          </li>
        </ul>
        <h3>Every request, and when</h3>
        <ul>
          <li>
            <strong>Steps 1, 2 and 4:</strong> none. The phone talks to the key over USB, NFC or
            Bluetooth, not over the internet.
          </li>
          <li>
            <strong>Step 3:</strong> <code>POST ipfs.aleph.cloud/api/v0/add</code>, twice — the list
            as one CAR file, every block it is made of, then a small JSON that names it. Then
            <code>PUT delegated-ipfs.dev/routing/v1/ipns/k51…</code>: an IPNS record, signed by the
            pointer key, pointing at the JSON, valid for 30 days.
          </li>
          <li>
            <strong>Step 5:</strong> <code>GET delegated-ipfs.dev/routing/v1/ipns/k51…</code>, and the
            record is checked against the name. Then <code>GET ipfs.aleph.cloud/ipfs/…</code> for the
            JSON and the CAR, and every block is checked against its hash before the list opens.
            There is no second way in at the moment: the public IPFS gateways that used to
            stand here were retired on 21 September 2026.
          </li>
        </ul>
        <p class="dim">
          Each step's own values appear under it once it has run; what happened, line by line, is
          at the <a href="#log">bottom of the page</a>.
        </p>
      {/if}
    </div>
  </section>

  {#if error}
    <p class="error" data-testid="error">{error}</p>
  {/if}

  <section class="step" data-status={status("key")}>
    <header>
      <h2><span class="n">1</span> {t.step1}</h2>
      <span class="badge">{t.status[status("key")]}</span>
    </header>
    {#if $lang === "de"}
      <p>
        Den Sicherheitsschlüssel dreimal berühren. Die ersten beiden Berührungen gewinnen die
        Identität aus dem Geheimnis auf dem Schlüssel zurück; die dritte lässt diese Identität
        signieren, was geschrieben wird. Derselbe Schlüssel ergibt auf jedem Telefon dieselbe
        Identität.
      </p>
    {:else}
      <p>
        Touch your security key three times. The first two touches recover your identity from
        the secret on the key; the third lets that identity sign what you write. The same key
        gives the same identity on every phone.
      </p>
    {/if}
    <p class="who">
      <span class="chip">{t.yourKey}</span> {t.nothingOnline}
    </p>
    <button data-testid="use-key" disabled={Boolean(busy)} onclick={useTheKey}>
      {busy === "key" ? t.asking : identity ? t.askAgain : t.useKey}
    </button>
    {#if busy === "key" && touches}
      <p class="touch-now" data-testid="touch-now">{touches}</p>
    {/if}
    {#if identity}
      <p class="dim">{t.compareHint}</p>
      <div class="tech" hidden={!details}>
        <dl>
          <dt>{t.didFingerprint}</dt>
          <dd class="fp" data-testid="did-fingerprint">{didFingerprint}</dd>
          <dt>{t.keyFingerprint}</dt>
          <dd class="fp" data-testid="key-fingerprint">{keyFingerprint}</dd>
        </dl>
        <p class="dim">{t.differ}</p>
      </div>
    {/if}
  </section>

  <section class="step" data-status={db ? "done" : status("list")}>
    <header>
      <h2><span class="n">2</span> {t.step2}</h2>
      <span class="badge">{db ? t.open : t.status[status("list")]}</span>
    </header>
    {#if db}
      <ul>
        {#each entries as entry, index (index)}
          <li>{entry}</li>
        {/each}
      </ul>
      {#if entries.length === 0}<p class="dim">{t.empty}</p>{/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input aria-label={t.newEntry} placeholder={t.placeholder} bind:value={newText} />
        <button type="submit" disabled={!newText.trim() || Boolean(busy)}>{t.add}</button>
      </form>
      <div class="tech" hidden={!details}>
        <p class="dim addr">{db.address}</p>
      </div>
    {:else}
      <p>{t.makeListHint}</p>
      <button data-testid="make-list" disabled={!stack || Boolean(busy)} onclick={makeList}>
        {t.makeList}
      </button>
      {#if !stack}<p class="dim">{t.needsStep1}</p>{/if}
    {/if}
    <p class="who">
      <span class="chip">{t.nobody}</span> {t.staysHere}
    </p>
  </section>

  <section class="step" data-status={status("backup")}>
    <header>
      <h2><span class="n">3</span> {t.step3}</h2>
      <span class="badge">{t.status[status("backup")]}</span>
    </header>
    {#if $lang === "de"}
      <p>
        Lädt die Liste als eine Datei zu Aleph hoch, einem öffentlichen Speichernetz, und
        veröffentlicht eine kleine signierte Notiz — den <em>Zeiger</em> — unter einem Namen, den
        nur dieser Schlüssel errechnen kann. Der Zeiger sagt, wo die Datei liegt; das andere
        Telefon braucht sonst nichts.
      </p>
    {:else}
      <p>
        Uploads the list as one file to Aleph, a public storage network, and publishes a small
        signed note — the <em>pointer</em> — under a name only your key can work out. The
        pointer says where the file is, so the other phone needs nothing else.
      </p>
    {/if}
    <p class="who">
      <span class="chip">Aleph · ipfs.aleph.cloud</span> {t.theFile}
      <span class="chip">delegated-ipfs.dev</span> {t.thePointer}
    </p>
    {#if $lang === "de"}
      <p class="note">
        Aleph nimmt die Datei an, verspricht aber nicht, sie zu behalten: Dafür braucht es einen
        Speicherauftrag, signiert von einer Wallet mit Guthaben bei Aleph. Für diesen Test genügt
        das, für eine Liste, die fehlen würde, noch nicht. Der Zeiger bittet um 30 Tage
        Aufbewahrung.
      </p>
    {:else}
      <p class="note">
        Aleph takes the file but does not promise to keep it: that needs a storage order signed
        by a wallet with credit on Aleph. Fine for this test, not yet for a list you would miss.
        The pointer asks to be kept for 30 days.
      </p>
    {/if}
    <!-- Where the backup goes. Aleph needs no account, which is why this page
         works with nothing typed in; the other two are the reader's own. -->
    <fieldset class="services">
      <legend>{t.whereTo}</legend>
      {#each SERVICES as service (service.id)}
        <label class="service">
          <input
            type="checkbox"
            checked={chosen(service.id)}
            data-testid={`service-${service.id}`}
            onchange={() => toggleService(service.id)}
          />
          <span>{t.services[service.id]}</span>
          {#if !service.needsKey}<span class="dim">{t.noAccount}</span>{/if}
        </label>
        {#if chosen(service.id) && service.needsKey}
          <div class="creds">
            <input
              class="mono"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder={t.keyPlaceholder}
              data-testid={`key-${service.id}`}
              value={detail(service.id, "key")}
              oninput={(event) => setDetail(service.id, "key", event.currentTarget.value)}
            />
            <input
              class="mono"
              autocomplete="off"
              spellcheck="false"
              placeholder={t.gatewayPlaceholder[service.id]}
              data-testid={`gateway-${service.id}`}
              value={detail(service.id, "gateway")}
              oninput={(event) => setDetail(service.id, "gateway", event.currentTarget.value)}
            />
          </div>
        {/if}
      {/each}
      {#if services.some((s) => s.key)}
        <p class="dim">
          {t.keysStay}
          <button type="button" class="linkish" data-testid="forget-keys" onclick={forgetKeys}>
            {t.forgetKeys}
          </button>
        </p>
      {/if}
    </fieldset>
    {#if missing.length > 0}
      <p class="dim" data-testid="missing-key">{t.needsKeyFor(missing.join(", "))}</p>
    {/if}
    <button
      data-testid="dehydrate"
      disabled={!db || Boolean(busy) || missing.length > 0}
      onclick={dehydrateNow}
    >
      {busy === "backup" ? t.backingUp : t.backUp}
    </button>
    {#if !db}<p class="dim">{t.needsList}</p>{/if}
    {#if pointer && done.backup}
      <div class="tech" hidden={!details}>
        <dl>
          <dt>{t.pointer}</dt>
          <dd class="fp" data-testid="pointer-name">{pointer.name}</dd>
          <dt>{t.backup}</dt>
          <dd class="fp">{pointer.metadataCID}</dd>
        </dl>
      </div>
    {/if}
  </section>

  <section class="step danger">
    <header>
      <h2><span class="n">4</span> {t.step4}</h2>
    </header>
    {#if $lang === "de"}
      <p>
        Löscht alles, was diese Seite auf diesem Telefon gespeichert hat, und lädt neu. Der
        Sicherheitsschlüssel behält sein Geheimnis — genau darum geht es: Danach müssen die
        Schritte 1 und 5 genügen.
      </p>
    {:else}
      <p>
        Deletes everything this page stored on this phone, and reloads. The security key keeps
        its secret, which is the point: afterwards, steps 1 and 5 have to be enough.
      </p>
    {/if}
    <p class="who"><span class="chip">{t.nobody}</span></p>
    <button data-testid="forget" disabled={Boolean(busy)} onclick={forget}>
      {t.forget}
    </button>
  </section>

  <section class="step" data-status={status("restore")}>
    <header>
      <h2><span class="n">5</span> {t.step5}</h2>
      <span class="badge">{t.status[status("restore")]}</span>
    </header>
    {#if $lang === "de"}
      <p>
        Fragt nach dem Zeiger unter dem Namen des Schlüssels, holt die Datei, die er nennt, und
        öffnet die Liste — nichts einzutippen, nichts mitgebracht. Danach in Schritt 2 einen
        Eintrag schreiben: Die Liste nimmt ihn an, weil es dieselbe Identität ist.
      </p>
    {:else}
      <p>
        Asks for the pointer under your key's name, fetches the file it names and opens the list
        — nothing to type in, nothing carried over. Then write an entry in step 2: the list
        accepts it because it is still you.
      </p>
    {/if}
    <p class="who">
      <span class="chip">delegated-ipfs.dev</span> {t.thePointer}
      <span class="chip">{t.gateways}</span> {t.fileOnly}
    </p>
    <button data-testid="hydrate" disabled={!stack || Boolean(busy)} onclick={hydrateNow}>
      {busy === "restore" ? t.restoring : t.getBack}
    </button>
    {#if !stack}<p class="dim">{t.needsStep1SameKey}</p>{/if}
    {#if delivery.gateway || delivery.peers}
      <!-- Which way the bytes came, once they have come. Two lines rather than
           one verdict: "the gateway was silent and the peers carried it" is a
           different thing to know than "it worked". -->
      <p class="paths">
        <span class="path" data-state={delivery.gateway === null ? "idle" : /^\d+ ms$/.test(delivery.gateway) ? "good" : "bad"}>
          {t.pathGateway} — {delivery.gateway ?? t.pathUnused}
        </span>
        <span class="path" data-state={delivery.peers ? "good" : "idle"}>
          {t.pathPeers} — {delivery.peers ? `${delivery.peers} · ${t.peersConnected(delivery.peerCount)}` : t.pathUnused}
        </span>
      </p>
    {/if}
    {#if done.restore}
      <p class="ok">{t.back}</p>
      {#if pointer}
        <div class="tech" hidden={!details}>
          <dl>
            <dt>{t.pointer}</dt>
            <dd class="fp">{pointer.name}</dd>
            <dt>{t.backup}</dt>
            <dd class="fp">{pointer.metadataCID} · {t.blocks(pointer.blocks)}</dd>
          </dl>
        </div>
      {/if}
    {/if}
  </section>

  <section class="tech" id="log" hidden={!details}>
    <h2>{t.whatHappened}</h2>
    <div class="log">
      {#each log as line, index (index)}<div>{line}</div>{/each}
    </div>
  </section>

  <footer>
    <a
      href="https://github.com/NiKrause/orbitdb-storage-bridge/blob/main/docs/RECOVERY-ON-A-SECOND-DEVICE.md"
      >{t.howItWorks}</a
    >
    ·
    <a href="https://github.com/NiKrause/orbitdb-storage-bridge">@le-space/orbitdb-storage-bridge</a>
    · MIT ·
    <span class="build">{build.version} · {build.commit} · {build.builtAt}</span>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--app-bg-0);
    color: var(--app-text);
    font: 15px/1.5 var(--app-font);
  }
  /* 64 px on top: the Le Space pill sits in the first 56. */
  main {
    max-width: 44rem;
    margin: 0 auto;
    padding: 64px 16px 48px;
  }
  h1 {
    margin: 0;
    font-size: 1.7rem;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 1.05rem;
  }
  .tag {
    color: var(--app-text-dim);
    margin: 4px 0 20px;
  }
  section {
    border: 1px solid var(--app-bg-3);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 0 0 14px;
  }
  section.danger {
    border-color: color-mix(in srgb, var(--app-red) 40%, var(--app-bg-0));
  }
  .dim {
    color: var(--app-text-dim);
  }
  .addr,
  .fp {
    font-family: var(--app-font-mono);
    overflow-wrap: anywhere;
  }
  .fp {
    font-size: 1.1rem;
    letter-spacing: 0.02em;
    margin: 0 0 10px;
  }
  dl {
    margin: 12px 0 0;
  }
  dt {
    color: var(--app-text-dim);
    font-size: 0.85rem;
  }
  button {
    background: var(--app-bg-2);
    color: var(--app-text);
    border: 1px solid var(--app-bg-3);
    border-radius: 8px;
    padding: 10px 14px;
    font: inherit;
    margin: 0 8px 8px 0;
  }
  button:disabled {
    opacity: 0.5;
  }
  .danger button {
    border-color: color-mix(in srgb, var(--app-red) 55%, var(--app-bg-0));
  }
  form {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  input {
    flex: 1;
    background: var(--app-bg-1);
    color: inherit;
    border: 1px solid var(--app-bg-3);
    border-radius: 8px;
    padding: 10px;
    font: inherit;
  }
  ul {
    margin: 8px 0;
    padding-left: 20px;
  }
  .error {
    color: var(--app-red);
    border: 1px solid color-mix(in srgb, var(--app-red) 55%, var(--app-bg-0));
    border-radius: 8px;
    padding: 10px 12px;
  }
  .log {
    font-family: var(--app-font-mono);
    font-size: 0.8rem;
    color: var(--app-text-dim);
    background: var(--app-bg-1);
    border-radius: 8px;
    padding: 10px;
    max-height: 220px;
    overflow: auto;
  }
  footer .ls-credit {
    display: flex;
    margin-top: 12px;
  }
  footer {
    /* dimmer than running text, still AA, as on the menu */
    color: color-mix(in srgb, var(--app-text-dim) 80%, var(--app-bg-0));
    font-size: 0.8rem;
    margin-top: 18px;
  }
  footer a {
    color: var(--app-accent);
  }
  .build {
    font-family: var(--app-font-mono);
  }
  .intro p {
    margin: 0 0 10px;
  }
  .plan {
    margin: 4px 0 12px;
    padding-left: 20px;
  }
  .plan li {
    margin: 4px 0;
  }
  .step header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .step h2 {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .step p {
    margin: 0 0 10px;
  }
  /* The number is the order the test runs in, not decoration. */
  .n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 1.6em;
    height: 1.6em;
    border: 1px solid var(--app-bg-3);
    border-radius: 50%;
    font-family: var(--app-font-mono);
    font-size: 0.85rem;
  }
  .badge {
    flex: none;
    font-size: 0.75rem;
    color: var(--app-text-dim);
  }
  .step[data-status="running"] {
    border-color: color-mix(in srgb, var(--app-amber) 50%, var(--app-bg-0));
  }
  .step[data-status="running"] .badge {
    color: var(--app-amber);
  }
  .step[data-status="done"] {
    border-color: color-mix(in srgb, var(--app-green) 45%, var(--app-bg-0));
  }
  .step[data-status="done"] .badge,
  .step[data-status="done"] .n {
    color: var(--app-green);
    border-color: var(--app-green);
  }
  .step[data-status="failed"] {
    border-color: color-mix(in srgb, var(--app-red) 55%, var(--app-bg-0));
  }
  .step[data-status="failed"] .badge {
    color: var(--app-red);
  }
  .services {
    border: 1px solid var(--line, #ddd);
    border-radius: 8px;
    padding: 10px 12px;
    margin: 10px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .services legend {
    padding: 0 4px;
    font-size: 0.8rem;
    color: var(--ink-2, #555);
  }
  .service {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
  }
  .creds {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 6px 24px;
  }
  .creds input {
    font-size: 0.8rem;
    padding: 6px 8px;
    border: 1px solid var(--line, #ddd);
    border-radius: 6px;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }

  .paths {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0 0;
    font-size: 0.85rem;
  }
  .path {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--line, #ddd);
    border-radius: 999px;
  }
  .path::before {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.85;
  }
  .path[data-state="good"] { color: var(--good, #12694b); }
  .path[data-state="bad"] { color: var(--bad, #a52020); }
  .path[data-state="idle"] { color: var(--ink-3, #777); }

  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    font-size: 0.85rem;
    color: var(--app-text-dim);
  }
  .chip {
    font-family: var(--app-font-mono);
    font-size: 0.75rem;
    color: var(--app-text);
    background: var(--app-bg-2);
    border: 1px solid var(--app-bg-3);
    border-radius: 999px;
    padding: 2px 9px;
  }
  .note {
    font-size: 0.85rem;
    color: var(--app-amber);
    border-left: 2px solid color-mix(in srgb, var(--app-amber) 50%, var(--app-bg-0));
    padding-left: 10px;
  }
  .ok {
    color: var(--app-green);
  }
  .tech {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--app-bg-3);
  }
  section.tech {
    border-top: 1px solid var(--app-bg-3);
  }
  button.ghost {
    background: none;
  }
  .explain h3 {
    margin: 14px 0 6px;
    font-size: 0.95rem;
  }
  .explain ol,
  .explain ul {
    margin: 0 0 8px;
    padding-left: 20px;
  }
  .explain li {
    margin: 6px 0;
  }
  .explain a {
    color: var(--app-accent);
  }
  code {
    font-size: 0.85em;
    color: var(--app-text);
    overflow-wrap: anywhere;
  }
  .touch-now {
    color: var(--app-amber);
    font-weight: 600;
  }
  button:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
  }
</style>
