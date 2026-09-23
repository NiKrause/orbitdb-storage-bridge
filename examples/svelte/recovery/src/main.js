// SPDX-License-Identifier: MIT
import { mount } from "svelte";
import "./tokens.css";
import { mountControls } from "./ui.js";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app") });

// Language and theme, top right. The application this demo came from had a
// shared brand module for this; that module is GPL-3.0 and did not travel.
mountControls();
