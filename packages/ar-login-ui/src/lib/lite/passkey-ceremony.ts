/**
 * The lite Login UI's passkey ceremony: a fixed script, allowed by its CSP hash (a page that draws
 * the ceremony adds `cspHashSource(LITE_PASSKEY_SCRIPT)`), never data.
 *
 * The form carrying `data-lite-passkey` (the request options' JSON, as the server checked them:
 * challenge, rpId, timeout, userVerification, allowCredentials) gets its hidden `credential`
 * filled in when it is sent: the assertion `navigator.credentials.get` returns, as JSON with its
 * binary parts in base64url (the shape the SPA's `@simplewebauthn/browser` posts). The ceremony
 * runs on the person's own press of the button (some browsers allow it only then).
 *
 * Without JavaScript nothing fills the field: the server refuses the post, and the page says so
 * (`<noscript>`). A browser without WebAuthn shows the form's `data-lite-passkey-unsupported`
 * text; a ceremony that fails or is cancelled shows `data-lite-passkey-error`, and the button can
 * be pressed again (the challenge is spent only by the server's check).
 */
export const LITE_PASSKEY_SCRIPT = `(function(){
var form=document.querySelector('form[data-lite-passkey]');
if(!form){return;}
function b64u(buffer){var b=new Uint8Array(buffer),s='';for(var i=0;i<b.length;i++){s+=String.fromCharCode(b[i]);}return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
function bytes(text){var s=text.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4){s+='=';}var raw=atob(s),out=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++){out[i]=raw.charCodeAt(i);}return out;}
function say(name){var message=form.getAttribute(name);if(!message){return;}
var p=form.querySelector('[data-lite-passkey-message]');
if(!p){p=document.createElement('p');p.setAttribute('role','alert');p.setAttribute('data-lite-passkey-message','');form.insertBefore(p,form.firstChild);}
p.textContent=message;}
form.addEventListener('submit',function(event){
var out=form.querySelector('input[name="credential"]');
if(!out||out.value){return;}
event.preventDefault();
if(!window.PublicKeyCredential||!navigator.credentials||!navigator.credentials.get){say('data-lite-passkey-unsupported');return;}
var buttons=form.querySelectorAll('button');
function enable(on){Array.prototype.forEach.call(buttons,function(b){b.disabled=!on;});}
var o;
try{o=JSON.parse(form.getAttribute('data-lite-passkey'));}catch(e){say('data-lite-passkey-error');return;}
enable(false);
navigator.credentials.get({publicKey:{challenge:bytes(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:o.userVerification,
allowCredentials:o.allowCredentials.map(function(c){var d={type:'public-key',id:bytes(c.id)};if(c.transports.length){d.transports=c.transports;}return d;})}}).then(function(credential){
var r=credential.response;
var json={id:credential.id,rawId:b64u(credential.rawId),type:credential.type,response:{authenticatorData:b64u(r.authenticatorData),clientDataJSON:b64u(r.clientDataJSON),signature:b64u(r.signature)}};
if(r.userHandle&&r.userHandle.byteLength){json.response.userHandle=b64u(r.userHandle);}
if(credential.authenticatorAttachment){json.authenticatorAttachment=credential.authenticatorAttachment;}
out.value=JSON.stringify(json);
enable(true);
form.submit();
},function(){enable(true);say('data-lite-passkey-error');});
});
})();`;
