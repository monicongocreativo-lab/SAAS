import * as contract from "../../src/offline/contract.mjs";
import * as store from "../../src/offline/store.mjs";

globalThis.offlineHarness = { ...store, ...contract };
