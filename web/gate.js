const form = document.getElementById('form');
const error = document.getElementById('error');
const button = document.getElementById('go');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  button.disabled = true;
  error.hidden = true;
  try {
    const res = await fetch('/api/access/passcode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: document.getElementById('passcode').value }),
    });
    if (res.ok) { location.reload(); return; }
    const data = await res.json().catch(() => ({}));
    error.textContent = data.detail || 'Something went wrong. Try again.';
  } catch {
    error.textContent = 'No connection. Try again.';
  }
  error.hidden = false;
  button.disabled = false;
  document.getElementById('passcode').select();
});
