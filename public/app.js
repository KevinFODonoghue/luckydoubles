// Confirm dialogs for destructive actions.
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-confirm]');
  if (form && !window.confirm(form.getAttribute('data-confirm'))) {
    e.preventDefault();
  }
});

// Flash messages arrive via the query string; strip it from the URL so a
// refresh or bookmark doesn't repeat them.
if (location.search && /[?&](msg|err)=/.test(location.search)) {
  const u = new URL(location.href);
  u.searchParams.delete('msg');
  u.searchParams.delete('err');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}

// Success flashes fade out on their own; errors stay until dismissed by navigation.
document.querySelectorAll('.flash-ok').forEach((el) => {
  setTimeout(() => el.classList.add('fade'), 5000);
});

// Live countdown to the signup deadline.
function tick() {
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const t = Number(el.getAttribute('data-deadline')) - Date.now();
    if (t <= 0) {
      el.textContent = 'Signups closed — refresh the page';
      el.classList.add('done');
      return;
    }
    const d = Math.floor(t / 86400000);
    const h = Math.floor((t % 86400000) / 3600000);
    const m = Math.floor((t % 3600000) / 60000);
    const s = Math.floor((t % 60000) / 1000);
    el.textContent = (d ? d + 'd ' : '') + h + 'h ' + m + 'm ' + s + 's';
  });
}
if (document.querySelector('[data-deadline]')) {
  tick();
  setInterval(tick, 1000);
}
