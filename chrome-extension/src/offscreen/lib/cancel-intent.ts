// Keys whose in-flight abort is a *pause* (user intends to resume) rather than
// a hard cancel. The background's offscreen/cancel message carries the intent;
// the handler in offscreen/index.ts records it here before aborting, and the
// HTTP download strategy consults it to decide whether the partial OPFS input
// file survives the abort (pause keeps the bytes for resume, cancel discards).
export const pauseIntentKeys = new Set<string>();
