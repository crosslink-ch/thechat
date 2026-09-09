import "@thechat/client/styles";
import { mountClient } from "@thechat/client";
import type { PlatformShell } from "@thechat/client/platform/contracts";
import * as shell from "./platform/shell.web";
shell satisfies PlatformShell;
mountClient(document.getElementById("root") as HTMLElement);
