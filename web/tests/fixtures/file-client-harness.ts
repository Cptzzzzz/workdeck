import * as drafts from "../../src/services/files/drafts";
import * as viewState from "../../src/services/files/view-state";
import * as terminalPressure from "../../src/services/files/terminal-pressure";
import * as pendingCancels from "../../src/services/files/pending-cancel-store";
import {
  FileClient,
  UncertainSaveError,
} from "../../src/services/files/client";
import { setCSRF } from "../../src/services/api";
import { downloadFile } from "../../src/services/files/download";
Object.assign(window, {
  workdeckFileTest: {
    FileClient,
    UncertainSaveError,
    setCSRF,
    drafts,
    viewState,
    terminalPressure,
    pendingCancels,
    downloadFile,
  },
});
