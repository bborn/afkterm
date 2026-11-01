import { z } from "zod";

export const sessionId = z.string().min(1).max(128);
export const sessionSchema = z.object({
  id: sessionId, name: z.string(), tabName: z.string().default(""), windowId: z.number(), windowName: z.string(),
  group: z.object({id:z.string(),name:z.string(),color:z.string().regex(/^(?:#[0-9a-f]{6}|color\(display-p3 [01]\.\d{5} [01]\.\d{5} [01]\.\d{5}\))$/i),collapsed:z.boolean()}).nullable().default(null),
  tabIndex: z.number(), paneIndex: z.number(), tty: z.string(), profile: z.string(),
  cwd: z.string(), processing: z.boolean(), atPrompt: z.boolean(), selected: z.boolean(),
  claude: z.boolean().default(false),
});
export type Session = z.infer<typeof sessionSchema>;
export const listSchema = z.object({ running: z.boolean(), sessions: z.array(sessionSchema), truncated: z.boolean(), metadataError: z.string().optional() });
export type SessionList = z.infer<typeof listSchema>;
export const keys = ["enter", "tab", "shift-tab", "escape", "ctrl-c", "ctrl-d", "up", "down", "left", "right", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type Key = typeof keys[number];
const notes = z.string().max(4000).refine(s => !/[\x00\x1b]/.test(s), "Terminal control sequences are not supported");
export const questionAnswerSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("select"), index: z.number().int().min(0).max(30), notes: notes.optional() }).strict(),
  z.object({ op: z.literal("focus"), index: z.number().int().min(0).max(30) }).strict(),
  z.object({ op: z.literal("toggle"), index: z.number().int().min(0).max(30) }).strict(),
  z.object({ op: z.literal("other"), text: notes }).strict(),
  z.object({ op: z.literal("next"), other: notes.optional() }).strict(),
  z.object({ op: z.literal("tab"), direction: z.union([z.literal(-1), z.literal(1)]) }).strict(),
  z.object({ op: z.literal("chat") }).strict(),
  z.object({ op: z.literal("submit") }).strict(),
  z.object({ op: z.literal("cancel") }).strict(),
]);
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("focus"), sessionId }).strict(),
  z.object({ kind: z.literal("rename"), sessionId, name: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("send"), sessionId, text: z.string().min(1).max(16000).refine(s => !s.includes("\0"), "NUL is not supported"), enter: z.boolean() }).strict(),
  z.object({ kind: z.literal("close"), sessionId, confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("close-tab"), sessionId, confirmed: z.literal(true) }).strict(),
  z.object({ kind: z.literal("key"), sessionId, key: z.enum(keys) }).strict(),
  z.object({ kind: z.literal("split"), sessionId, direction: z.enum(["horizontal", "vertical"]) }).strict(),
  z.object({ kind: z.literal("new-tab"), sessionId }).strict(),
  z.object({ kind: z.literal("new-window") }).strict(),
  // Answer Claude's AskUserQuestion dialog. `prompt` is the question the client saw.
  z.object({ kind: z.literal("question"), sessionId, prompt: z.string().max(2000), answer: questionAnswerSchema }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
// Claude Code's AskUserQuestion dialog as read from the screen (see server/question.ts).
export const questionSchema = z.object({
  tabs: z.array(z.object({ label: z.string(), answered: z.boolean() })),
  submitTab: z.boolean(),
  prompt: z.string(),
  multiSelect: z.boolean(),
  options: z.array(z.object({ key: z.string(), label: z.string(), detail: z.string().optional(), checked: z.boolean() })),
  other: z.object({ key: z.string(), text: z.string(), checked: z.boolean() }).optional(),
  submit: z.enum(["Submit", "Next"]).optional(),
  chat: z.object({ key: z.string().optional() }).optional(),
  // Which row has the cursor: "option:<i>", "other", "submit" or "chat".
  cursor: z.string().nullable(),
  preview: z.string().optional(),
  notes: z.object({ text: z.string(), editing: z.boolean() }).optional(),
  review: z.object({ answers: z.array(z.object({ question: z.string(), answer: z.string() })), message: z.string() }).optional(),
});
export type Question = z.infer<typeof questionSchema>;
export const actionResult = z.object({ sessionId: sessionId.nullable() });
export const chatMessageSchema = z.object({
  id:z.string(), role:z.enum(["user","assistant","tool"]), text:z.string(),
  name:z.string().optional(), status:z.enum(["pending","completed","error"]).optional(), result:z.string().optional(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export const promptSchema = z.object({ question:z.string(), options:z.array(z.object({ key:z.string(), label:z.string(), detail:z.string().optional(), selected:z.boolean() })), text:z.string() });
export type Prompt = z.infer<typeof promptSchema>;
export const claudeViewSchema = z.object({
  source:z.enum(["transcript","screen"]), identity:z.string(), messages:z.array(chatMessageSchema), notice:z.string().optional(),
  prompt:promptSchema.optional(), question:questionSchema.optional(), working:z.boolean().default(false),
  // Claude's permission mode from its status line ("plan mode", "accept edits"…); "default" when none is shown.
  mode:z.string().optional(),
  // A select menu is on screen that couldn't be turned into buttons (needs arrows + Enter).
  menu:z.boolean().default(false),
});
export type ClaudeView = z.infer<typeof claudeViewSchema>;
export const previewSchema = z.object({text:z.string(),truncated:z.boolean(),claude:claudeViewSchema.nullable().default(null)});
export type Preview = z.infer<typeof previewSchema>;
export const inputSkillSchema=z.object({command:z.string(),label:z.string(),description:z.string(),hint:z.string(),source:z.string()});
export type InputSkill=z.infer<typeof inputSkillSchema>;
export const inputOptionsSchema=z.object({skills:z.array(inputSkillSchema),truncated:z.boolean()});
export type InputOptions=z.infer<typeof inputOptionsSchema>;
export const uploadSchema=z.object({uploadId:z.string().uuid(),name:z.string().min(1).max(255)}).strict();
export type Upload=z.infer<typeof uploadSchema>;
export const claudeSendSchema=z.object({
  text:z.string().max(16000).refine(s=>!/[\x00\x1b]/.test(s),"Terminal control sequences are not supported in chat"),
  files:z.array(uploadSchema).max(10),
}).strict();
export type ClaudeSend=z.infer<typeof claudeSendSchema>;

// Messages pushed over the live socket for the session a client is viewing.
export type LiveMessage =
  | { type: "preview"; preview: Preview; at: number }
  | { type: "error"; message: string; at: number };
