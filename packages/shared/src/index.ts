/**
 * `@dino/shared` — the frozen contracts every other module builds against.
 *
 * Wave 1 freezes these. Later waves may ADD to them; breaking changes must be
 * proposed in PLAN.md's Progress Log first.
 */
export * from './texture-spec.js';
export * from './api.js';
export * from './room.js';
// Added by Wave 2B (WS-C): low-poly dino box data + the side-projection unwrap.
export * from './dino-models.js';
