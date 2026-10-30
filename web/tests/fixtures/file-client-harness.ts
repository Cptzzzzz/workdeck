import * as drafts from "../../src/services/files/drafts";
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
    downloadFile,
  },
});
