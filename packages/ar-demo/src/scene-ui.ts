/**
 * What every page runs (served as /assets/scene.js, after the scene's own script): the day or
 * night choice, the button that changes it, and the city behind the page. The page works without
 * any of it: no script, no WebGL or a failed download leave a plain background and the same words.
 * No backticks, dollar-brace or backslashes in here: this is a template literal.
 */
export const SCENE_UI_JS = `var page = document.documentElement;
var canvas = document.querySelector('canvas.city');
var toggle = document.getElementById('theme');
var form = document.getElementById('start-form');
var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var stored = null;
try { stored = window.localStorage.getItem('authrim-theme'); } catch (e) { stored = null; }
// The visitor's own choice if they made one, else their system's light or dark.
var theme = stored === 'day' || stored === 'night' ? stored
  : window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night';
var scene = { city: null, reduced: reduced, onCity: null };
window.AuthrimScene = scene;
var loader = document.getElementById('city-js');
// The city comes when its script has arrived: at once if it is here already, later if not, never
// if it fails. Nothing on the page waits for it.
function build() {
  if (scene.city || !canvas || !window.AuthrimCity) return;
  try { scene.city = window.AuthrimCity.create(canvas, { reducedMotion: reduced, theme: theme }); } catch (e) { scene.city = null; }
  if (!scene.city) return;
  canvas.hidden = false;
  page.setAttribute('data-scene', 'city');
  if (scene.onCity) scene.onCity(scene.city);
}
if (canvas) canvas.hidden = true;
page.setAttribute('data-scene', 'none');
build();
if (!scene.city && loader) loader.addEventListener('load', build);
// The check runs unseen as soon as its script has come, and shows itself only to a visitor it has
// to ask something. The button does not wait for it to load, only for an answer it is working on.
var check = document.getElementById('check');
var button = form ? form.querySelector('button[type=submit]') : null;
var frame = check ? check.parentNode : null;
var widget = null;
var verified = false;
var waiting = false;
var label = button ? button.textContent : '';
function busy(on) {
  waiting = on;
  if (!button) return;
  button.disabled = on;
  button.setAttribute('aria-busy', on ? 'true' : 'false');
  button.textContent = on ? button.getAttribute('data-wait') || label : label;
}
function send() {
  if (scene.city) scene.city.pulse();
  form.submit();
}
function draw() {
  if (!check || !window.turnstile || widget !== null) return;
  try {
    widget = window.turnstile.render(check, {
      sitekey: check.getAttribute('data-sitekey'),
      language: check.getAttribute('data-language'),
      size: 'flexible',
      theme: theme === 'day' ? 'light' : 'dark',
      appearance: 'interaction-only',
      callback: function () { verified = true; if (waiting) send(); },
      'expired-callback': function () { verified = false; },
      'error-callback': function () { verified = false; busy(false); },
      'before-interactive-callback': function () { if (frame) frame.classList.add('asking'); },
      'after-interactive-callback': function () { if (frame) frame.classList.remove('asking'); }
    });
  } catch (e) { widget = null; }
}
// Day or night changed: the check is drawn again to match, and asked again.
function redraw() {
  if (widget === null || !window.turnstile) return;
  try { window.turnstile.remove(widget); } catch (e) { /* gone already */ }
  widget = null;
  verified = false;
  draw();
}
function show() {
  page.setAttribute('data-theme', theme);
  if (toggle) toggle.setAttribute('aria-pressed', theme === 'day' ? 'true' : 'false');
}
show();
if (toggle) {
  toggle.hidden = false;
  toggle.addEventListener('click', function () {
    theme = theme === 'day' ? 'night' : 'day';
    try { window.localStorage.setItem('authrim-theme', theme); } catch (e) { /* this page only */ }
    show();
    if (scene.city) scene.city.setTheme(theme, reduced);
    redraw();
  });
}
// The moment the request is made: the sheet answers before the next page does.
var checker = document.getElementById('check-js');
draw();
if (widget === null && checker) checker.addEventListener('load', draw);
// The moment the request is made: the sheet answers before the next page does. Without the check's
// script the form goes as it is and the server refuses it; with it, the form goes once the check
// has answered.
if (form) form.addEventListener('submit', function (event) {
  if (widget === null || verified) { if (scene.city) scene.city.pulse(); return; }
  event.preventDefault();
  busy(true);
});
`;
