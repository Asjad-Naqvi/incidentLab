const form = document.querySelector('#login-form');
const message = document.querySelector('#message');
async function check() {
  try {
    const response = await fetch('/api/auth/status');
    if (!response.ok) throw new Error();
    const status = await response.json();
    if (status.authenticated) { window.location.replace('/'); return; }
    document.querySelector('#setup').hidden = !status.setupRequired;
    form.hidden = status.setupRequired;
    message.textContent = '';
  } catch { message.textContent = 'Unable to connect. Check the server and database migrations.'; }
}
document.querySelector('#check-setup').addEventListener('click',check);
form.addEventListener('submit',async event => {
  event.preventDefault();
  const button = document.querySelector('#sign-in'); button.disabled = true;
  message.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/auth/login',{ method: 'POST',headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value,password: form.password.value }) });
    const result = await response.json();
    form.password.value = '';
    if (!response.ok) { message.textContent = result.error || 'Sign-in failed'; return; }
    window.location.replace('/');
  } catch { form.password.value = ''; message.textContent = 'Connection lost. Please try again.'; }
  finally { button.disabled = false; }
});
await check();
