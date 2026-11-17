// What the pages load: the scene, on the page's own global, nothing else.
import { createCity } from './city.js';

window.AuthrimCity = { create: createCity };
