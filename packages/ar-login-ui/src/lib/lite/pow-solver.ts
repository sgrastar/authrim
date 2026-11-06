/**
 * The lite Login UI's proof-of-work solver: the one fixed script a lite page may run (allowed by
 * its CSP hash; a page that embeds a challenge adds `cspHashSource(LITE_POW_SOLVER_SCRIPT)`).
 *
 * A form carrying `data-lite-pow` (the challenge's JSON: algorithm, challenge, maxnumber, salt,
 * signature) gets a hidden `human_verification_response` filled in before it is sent: the number
 * whose SHA-256 of `salt + number` is the challenge, as ALTCHA v1 (the base64 of the JSON of
 * algorithm, challenge, number, salt and signature). While it works, the form's buttons are
 * disabled; the button pressed is kept (`requestSubmit(submitter)`, or, in a browser without it,
 * the button's `formaction` and its name and value carried over to a plain `submit()`).
 *
 * Without JavaScript nothing fills the field: the backend refuses the proof, and the page says so
 * (`<noscript>`). When the browser cannot solve it (no Web Crypto, a failure), the buttons come
 * back and the form shows its `data-lite-pow-error` text. The proof is never skipped.
 */
export const LITE_POW_SOLVER_SCRIPT = `(function(){
var forms=document.querySelectorAll('form[data-lite-pow]');
function hex(buffer){var b=new Uint8Array(buffer),s='';for(var i=0;i<b.length;i++){s+=(b[i]<16?'0':'')+b[i].toString(16);}return s;}
function solve(c){var enc=new TextEncoder();var n=0;
return new Promise(function(resolve,reject){(function next(){
if(n>c.maxnumber){reject(new Error('unsolved'));return;}
crypto.subtle.digest('SHA-256',enc.encode(c.salt+n)).then(function(d){
if(hex(d)===c.challenge){resolve(n);return;}n+=1;next();},reject);})();});}
Array.prototype.forEach.call(forms,function(form){
form.addEventListener('submit',function(event){
var out=form.querySelector('input[name="human_verification_response"]');
if(!out||out.value){return;}
event.preventDefault();
var submitter=event.submitter||null;
var buttons=form.querySelectorAll('button');
Array.prototype.forEach.call(buttons,function(b){b.disabled=true;});
function failed(){Array.prototype.forEach.call(buttons,function(b){b.disabled=false;});
var message=form.getAttribute('data-lite-pow-error');
if(message&&!form.querySelector('[data-lite-pow-message]')){var p=document.createElement('p');p.setAttribute('role','alert');p.setAttribute('data-lite-pow-message','');p.textContent=message;form.insertBefore(p,form.firstChild);}}
var started;
try{var c=JSON.parse(form.getAttribute('data-lite-pow'));started=solve(c);}catch(e){failed();return;}
started.then(function(number){
out.value=btoa(JSON.stringify({algorithm:c.algorithm,challenge:c.challenge,number:number,salt:c.salt,signature:c.signature}));
Array.prototype.forEach.call(buttons,function(b){b.disabled=false;});
if(form.requestSubmit){form.requestSubmit(submitter);return;}
if(submitter&&submitter.getAttribute('formaction')){form.setAttribute('action',submitter.getAttribute('formaction'));}
if(submitter&&submitter.name){var keep=document.createElement('input');keep.type='hidden';keep.name=submitter.name;keep.value=submitter.value;form.appendChild(keep);}
form.submit();
},failed);
});
});
})();`;
