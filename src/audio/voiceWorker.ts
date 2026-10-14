/**
 * Builds the stranger's and the keypad's voices off the main thread: they take
 * half a second or more to synthesise, which would freeze the game if done
 * while it runs. See audio/voice.ts.
 */
import { buildVoices } from './voice';

interface Scope {
  onmessage: ((e: MessageEvent<{ sr: number }>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
const scope = self as unknown as Scope;

scope.onmessage = (e) => {
  const voices = buildVoices(e.data.sr);
  const buffers = [
    ...voices.gargles,
    ...voices.inhales,
    ...voices.exhales,
    ...voices.notes.flat(),
    ...voices.pads,
    ...voices.songs,
  ].map((a) => a.buffer);
  scope.postMessage(voices, buffers);
};
