import * as drafts from "../../src/services/files/drafts";
import {
  FileClient,
  UncertainSaveError,
} from "../../src/services/files/client";
import { setCSRF } from "../../src/services/api";
Object.assign(window, {
  workdeckFileTest: { FileClient, UncertainSaveError, setCSRF, drafts },
});
