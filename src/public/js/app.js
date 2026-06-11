(function () {
  const root = document.documentElement;
  const storedTheme = window.localStorage.getItem('pfl-theme');

  if (storedTheme === 'light' || storedTheme === 'dark') {
    root.setAttribute('data-theme', storedTheme);
  }

  function refreshThemeButton() {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    const theme = root.getAttribute('data-theme') || 'dark';
    button.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }

  refreshThemeButton();

  document.addEventListener('click', function (event) {
    const themeButton = event.target.closest('[data-theme-toggle]');
    if (themeButton) {
      const nextTheme = (root.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', nextTheme);
      window.localStorage.setItem('pfl-theme', nextTheme);
      refreshThemeButton();
    }

    const toastButton = event.target.closest('[data-dismiss-toast]');
    if (toastButton) {
      const toast = toastButton.closest('[data-toast]');
      if (toast) toast.remove();
    }
  });

  window.setTimeout(function () {
    const toast = document.querySelector('[data-toast]');
    if (toast) toast.classList.add('toast-hiding');
  }, 3600);

  window.setTimeout(function () {
    const toast = document.querySelector('[data-toast]');
    if (toast) toast.remove();
  }, 4400);

  document.querySelectorAll('[data-editor]').forEach(function (editor) {
    const surface = editor.querySelector('[data-editor-surface]');
    const hidden = editor.querySelector('input[type="hidden"]');
    if (!surface || !hidden) return;

    hidden.value = surface.innerHTML;

    editor.querySelectorAll('[data-command]').forEach(function (button) {
      button.addEventListener('mousedown', function (event) {
        event.preventDefault();
      });

      button.addEventListener('click', function () {
        const command = button.getAttribute('data-command');
        surface.focus();

        if (command === 'createLink') {
          const rawUrl = window.prompt('Link URL');
          if (!rawUrl) return;
          const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl);
          const url = hasScheme ? rawUrl : `https://${rawUrl}`;
          document.execCommand('createLink', false, url);
        } else {
          document.execCommand(command, false, null);
        }

        hidden.value = surface.innerHTML;
      });
    });

    surface.addEventListener('input', function () {
      hidden.value = surface.innerHTML;
    });
  });

  document.querySelectorAll('[data-editor-form]').forEach(function (form) {
    form.addEventListener('submit', function () {
      form.querySelectorAll('[data-editor]').forEach(function (editor) {
        const surface = editor.querySelector('[data-editor-surface]');
        const hidden = editor.querySelector('input[type="hidden"]');
        if (surface && hidden) hidden.value = surface.innerHTML;
      });
    });
  });

  document.querySelectorAll('[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      const message = form.getAttribute('data-confirm') || 'Are you sure?';
      if (!window.confirm(message)) {
        event.preventDefault();
      }
    });
  });

  document.querySelectorAll('[data-confirm-checkbox]').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      if (checkbox.checked && !window.confirm('Delete this attachment when saving?')) {
        checkbox.checked = false;
      }
    });
  });
})();
