// three.js names its objects with Math.random (its generateUUID). Nothing here is a secret, but
// a code scanner cannot know that from a bundled file, so the bundle draws from the platform's
// own generator instead: scripts/build-city.ts puts this in place of every Math.random.
const one = new Uint32Array(1);

export function cityRandom() {
  crypto.getRandomValues(one);
  return one[0] / 4294967296;
}
