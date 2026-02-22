import { createBotSkill } from "./create-bot";
import { theChatBackendSkill } from "./thechat-backend";
import type { SkillInfo } from "../types";

export const builtinSkills: SkillInfo[] = [createBotSkill, theChatBackendSkill];
