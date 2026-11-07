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
 * A sign-up's form carries `data-lite-passkey-create` instead (the creation options' JSON: challenge,
 * rp, user, pubKeyCredParams, timeout, excludeCredentials, residentKey, userVerification,
 * authenticatorAttachment): its `credential` is the registration `navigator.credentials.create`
 * returns (clientDataJSON, attestationObject, transports), in the same encoding.
 *
 * Without JavaScript nothing fills the field: the server refuses the post, and the page says so
 * (`<noscript>`). A browser without WebAuthn shows the form's `data-lite-passkey-unsupported`
 * text; a ceremony that fails or is cancelled shows `data-lite-passkey-error`, and the button can
 * be pressed again (the challenge is spent only by the server's check).
 */
export const LITE_PASSKEY_SCRIPT = `(function(){
var form=document.querySelector('form[data-lite-passkey],form[data-lite-passkey-create]');
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
var creating=form.hasAttribute('data-lite-passkey-create');
if(!window.PublicKeyCredential||!navigator.credentials||!(creating?navigator.credentials.create:navigator.credentials.get)){say('data-lite-passkey-unsupported');return;}
var buttons=form.querySelectorAll('button');
function enable(on){Array.prototype.forEach.call(buttons,function(b){b.disabled=!on;});}
function failed(){enable(true);say('data-lite-passkey-error');}
var o;
try{o=JSON.parse(form.getAttribute(creating?'data-lite-passkey-create':'data-lite-passkey'));}catch(e){say('data-lite-passkey-error');return;}
enable(false);
if(creating){
var selection={residentKey:o.residentKey,requireResidentKey:o.residentKey==='required',userVerification:o.userVerification};
if(o.authenticatorAttachment){selection.authenticatorAttachment=o.authenticatorAttachment;}
navigator.credentials.create({publicKey:{challenge:bytes(o.challenge),rp:{id:o.rp.id,name:o.rp.name},
user:{id:bytes(o.user.id),name:o.user.name,displayName:o.user.displayName},
pubKeyCredParams:o.pubKeyCredParams.map(function(p){return {type:'public-key',alg:p.alg};}),
timeout:o.timeout,attestation:'none',authenticatorSelection:selection,
excludeCredentials:o.excludeCredentials.map(function(c){var d={type:'public-key',id:bytes(c.id)};if(c.transports.length){d.transports=c.transports;}return d;})}}).then(function(credential){
var r=credential.response;
var json={id:credential.id,rawId:b64u(credential.rawId),type:credential.type,response:{clientDataJSON:b64u(r.clientDataJSON),attestationObject:b64u(r.attestationObject),
transports:typeof r.getTransports==='function'?r.getTransports():[]}};
if(credential.authenticatorAttachment){json.authenticatorAttachment=credential.authenticatorAttachment;}
out.value=JSON.stringify(json);
enable(true);
form.submit();
},failed);
return;}
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
