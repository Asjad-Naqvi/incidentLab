const button = document.querySelector('#start-demo');
const message = document.querySelector('#message');
button.addEventListener('click', async () => {
  button.disabled = true; message.textContent = 'Preparing your private sandbox…';
  try {
    const response = await fetch('/api/demo/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '1' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to start the demo');
    window.location.replace('/');
  } catch (error) { message.textContent = error.message; button.disabled = false; }
});
