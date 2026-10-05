(function () {
  const root = document.documentElement;
  const THEME_COOKIE = 'sit_theme';
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const ATTACHMENT_TYPES = IMAGE_TYPES.concat(['application/pdf']);
  const EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp'
  };

  function readThemeCookie() {
    const match = document.cookie.match(/(?:^|;\s*)sit_theme=(light|dark)(?:;|$)/);
    return match ? match[1] : '';
  }

  function saveTheme(theme) {
    // A cookie (not localStorage) so the server renders the right theme and pages never flash.
    document.cookie = THEME_COOKIE + '=' + theme + '; path=/; max-age=31536000; samesite=lax';
  }

  // One-time move of the older per-browser setting into the cookie.
  try {
    window.localStorage.removeItem('pfl-theme');
    const legacyTheme = window.localStorage.getItem('sit-theme');
    if ((legacyTheme === 'light' || legacyTheme === 'dark') && !readThemeCookie()) {
      saveTheme(legacyTheme);
      root.setAttribute('data-theme', legacyTheme);
    }
    window.localStorage.removeItem('sit-theme');
  } catch (_error) {
    // Storage can be unavailable (private mode); the cookie is the source of truth anyway.
  }

  function refreshThemeButton() {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    const theme = root.getAttribute('data-theme') || 'dark';
    button.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }

  refreshThemeButton();

  document.querySelectorAll('time[data-local-time]').forEach(function (element) {
    const date = new Date(element.getAttribute('datetime'));
    if (Number.isNaN(date.getTime())) return;
    element.textContent = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
    element.title = date.toString();
  });

  document.addEventListener('click', function (event) {
    const themeButton = event.target.closest('[data-theme-toggle]');
    if (themeButton) {
      const nextTheme = (root.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', nextTheme);
      saveTheme(nextTheme);
      refreshThemeButton();
      const themeColor = document.querySelector('meta[name="theme-color"]');
      if (themeColor) themeColor.setAttribute('content', nextTheme === 'light' ? '#ffffff' : '#111823');
    }

    const toastButton = event.target.closest('[data-dismiss-toast]');
    if (toastButton) {
      const toast = toastButton.closest('[data-toast]');
      if (toast) toast.remove();
    }
  });

  const autoHideToast = document.querySelector('[data-toast]:not([data-toast-sticky])');
  if (autoHideToast) {
    window.setTimeout(function () {
      autoHideToast.classList.add('toast-hiding');
    }, 3600);
    window.setTimeout(function () {
      autoHideToast.remove();
    }, 4400);
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function refreshAttachmentList(input) {
    const form = input.form;
    const list = form && form.querySelector('[data-attachment-list]');
    if (!list) return;
    list.innerHTML = '';
    Array.from(input.files).forEach(function (file) {
      const item = document.createElement('li');
      item.textContent = file.name + ' (' + formatSize(file.size) + ')';
      list.appendChild(item);
    });
    list.hidden = input.files.length === 0;
  }

  // Adds pasted or dropped images to the form's file input, so screenshots are saved as attachments.
  function addFilesToInput(input, files) {
    if (!input || typeof DataTransfer === 'undefined') return 0;
    const transfer = new DataTransfer();
    Array.from(input.files).forEach(function (file) {
      transfer.items.add(file);
    });

    let added = 0;
    files.forEach(function (file, index) {
      if (ATTACHMENT_TYPES.indexOf(file.type) === -1) return;
      let named = file;
      if (IMAGE_TYPES.indexOf(file.type) !== -1 && (!file.name || /^image\.\w+$/i.test(file.name))) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        named = new File([file], 'screenshot-' + stamp + (index ? '-' + index : '') + EXTENSIONS[file.type], { type: file.type });
      }
      transfer.items.add(named);
      added += 1;
    });

    input.files = transfer.files;
    refreshAttachmentList(input);
    return added;
  }

  function filesFromTransfer(dataTransfer) {
    if (!dataTransfer) return [];
    const files = [];
    Array.from(dataTransfer.items || []).forEach(function (item) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    });
    if (files.length === 0 && dataTransfer.files) {
      Array.from(dataTransfer.files).forEach(function (file) {
        files.push(file);
      });
    }
    return files;
  }

  function showFormMessage(form, message, isNote) {
    const box = form && form.querySelector('[data-form-error]');
    if (!box) {
      window.alert(message);
      return;
    }
    box.textContent = message;
    box.classList.toggle('form-note', Boolean(isNote));
    box.setAttribute('role', isNote ? 'status' : 'alert');
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }


  document.querySelectorAll('[data-editor]').forEach(function (editor) {
    const surface = editor.querySelector('[data-editor-surface]');
    const hidden = editor.querySelector('input[type="hidden"]');
    if (!surface || !hidden) return;
    const form = editor.closest('form');
    const fileInput = form && form.querySelector('[data-attachment-input]');

    function sync() {
      // Inline images are never saved (the server strips them), so keep them out of the text.
      surface.querySelectorAll('img').forEach(function (image) {
        image.remove();
      });
      hidden.value = surface.innerHTML;
    }

    function takeFiles(files) {
      if (files.length === 0) return false;
      const added = addFilesToInput(fileInput, files);
      if (added > 0) {
        showFormMessage(form, added === 1
          ? 'Screenshot added as an attachment below.'
          : added + ' files added as attachments below.', true);
      } else {
        showFormMessage(form, 'Only images and PDFs can be attached. Use the Add files button below.');
      }
      return true;
    }

    sync();

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

        sync();
      });
    });

    surface.addEventListener('paste', function (event) {
      if (takeFiles(filesFromTransfer(event.clipboardData))) {
        event.preventDefault();
      }
    });

    surface.addEventListener('dragover', function (event) {
      if (event.dataTransfer && Array.from(event.dataTransfer.types || []).indexOf('Files') !== -1) {
        event.preventDefault();
      }
    });

    surface.addEventListener('drop', function (event) {
      if (takeFiles(filesFromTransfer(event.dataTransfer))) {
        event.preventDefault();
      }
    });

    surface.addEventListener('input', sync);
  });

  document.querySelectorAll('[data-attachment-input]').forEach(function (input) {
    input.addEventListener('change', function () {
      refreshAttachmentList(input);
    });
  });

  // Checks the form before it is sent, so nothing typed is lost to a server-side rejection.
  function validateIssueForm(form) {
    const name = form.querySelector('[name="poster_name"]');
    if (name && !name.value.trim()) {
      name.focus();
      return 'Add your name before saving.';
    }

    const departments = form.querySelectorAll('[name="department_ids"]');
    if (departments.length > 0 && !Array.from(departments).some(function (box) { return box.checked; })) {
      departments[0].focus();
      return 'Choose at least one department before saving.';
    }

    const requiredEditors = form.querySelectorAll('[data-editor-required]');
    for (const editor of requiredEditors) {
      const surface = editor.querySelector('[data-editor-surface]');
      if (surface && !surface.textContent.trim()) {
        surface.focus();
        return 'Add the ' + (editor.getAttribute('data-editor-label') || 'issue').toLowerCase() + ' details before saving.';
      }
    }

    const fileInput = form.querySelector('[data-attachment-input]');
    if (fileInput) {
      const maxFiles = Number(form.getAttribute('data-max-files') || 0);
      const maxSize = Number(form.getAttribute('data-max-file-size') || 0);
      const files = Array.from(fileInput.files);
      if (maxFiles && files.length > maxFiles) {
        return 'Attach up to ' + maxFiles + ' files at a time.';
      }
      const tooBig = files.find(function (file) { return maxSize && file.size > maxSize; });
      if (tooBig) {
        return tooBig.name + ' is larger than ' + formatSize(maxSize) + '. Attach a smaller file.';
      }
      const wrongType = files.find(function (file) { return ATTACHMENT_TYPES.indexOf(file.type) === -1; });
      if (wrongType) {
        return wrongType.name + ' is not an image or PDF.';
      }
    }

    return '';
  }

  document.querySelectorAll('[data-editor-form]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      form.querySelectorAll('[data-editor]').forEach(function (editor) {
        const surface = editor.querySelector('[data-editor-surface]');
        const hidden = editor.querySelector('input[type="hidden"]');
        if (surface && hidden) hidden.value = surface.innerHTML;
      });

      const problem = validateIssueForm(form);
      if (problem) {
        event.preventDefault();
        showFormMessage(form, problem);
      }
    });
  });

  const TITLE_SMALL_WORDS = ['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs'];

  // Same rules as titleFromFilename in src/library.js: "new-hope-network.xlsx" becomes "New Hope Network".
  function titleFromFilename(filename) {
    const dot = filename.lastIndexOf('.');
    const stem = (dot > 0 ? filename.slice(0, dot) : filename).replace(/[_.\s-]+/g, ' ').trim();
    if (!stem || stem !== stem.toLowerCase()) return stem.slice(0, 160);
    return stem.split(' ').map(function (word, index) {
      return index > 0 && TITLE_SMALL_WORDS.indexOf(word) !== -1 ? word : word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ').slice(0, 160);
  }

  // One editable title per chosen file, sent in the same order as the files.
  document.querySelectorAll('[data-library-files]').forEach(function (input) {
    const form = input.form;
    const panel = form.querySelector('[data-library-titles]');
    const list = form.querySelector('[data-library-title-list]');
    if (!panel || !list) return;

    input.addEventListener('change', function () {
      const previous = {};
      list.querySelectorAll('[data-file-name]').forEach(function (field) {
        previous[field.getAttribute('data-file-name')] = field.value;
      });
      list.innerHTML = '';
      Array.from(input.files).forEach(function (file, index) {
        const row = document.createElement('div');
        row.className = 'field';
        const label = document.createElement('label');
        label.setAttribute('for', 'library-title-' + index);
        label.textContent = file.name + ' (' + formatSize(file.size) + ')';
        const field = document.createElement('input');
        field.type = 'text';
        field.id = 'library-title-' + index;
        field.name = 'titles';
        field.maxLength = 160;
        field.setAttribute('data-file-name', file.name);
        field.value = Object.prototype.hasOwnProperty.call(previous, file.name) ? previous[file.name] : titleFromFilename(file.name);
        row.appendChild(label);
        row.appendChild(field);
        list.appendChild(row);
      });
      panel.hidden = input.files.length === 0;
    });
  });

  // Checks library uploads before sending, so a large upload is not wasted on a file the server would refuse.
  document.querySelectorAll('[data-library-form]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      const input = form.querySelector('input[type="file"]');
      if (!input) return;
      const files = Array.from(input.files);
      const maxFiles = Number(form.getAttribute('data-max-files') || 0);
      const maxSize = Number(form.getAttribute('data-max-file-size') || 0);
      const allowed = (form.getAttribute('data-accept') || '').split(',');
      let problem = '';
      if (maxFiles && files.length > maxFiles) {
        problem = 'Upload up to ' + maxFiles + ' files at a time.';
      }
      files.forEach(function (file) {
        if (problem) return;
        const dot = file.name.lastIndexOf('.');
        const extension = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
        if (allowed.indexOf(extension) === -1) {
          problem = file.name + ' is not a supported file type.';
        } else if (maxSize && file.size > maxSize) {
          problem = file.name + ' is larger than ' + formatSize(maxSize) + '.';
        }
      });
      if (problem) {
        event.preventDefault();
        showFormMessage(form, problem);
      }
    });
  });

  // Applies the spreadsheet's own column widths; the page's security policy blocks inline style attributes.
  document.querySelectorAll('.sheet-table').forEach(function (table) {
    let total = 0;
    table.querySelectorAll('col[data-width]').forEach(function (col) {
      const width = Number(col.getAttribute('data-width')) || 64;
      col.style.width = width + 'px';
      total += width;
    });
    table.style.width = total + 'px';
    table.classList.add('sheet-table-sized');
  });

  document.querySelectorAll('[data-sheet-viewer]').forEach(function (viewer) {
    const tabs = viewer.querySelectorAll('[data-sheet-tab]');
    const panels = viewer.querySelectorAll('[data-sheet-panel]');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        const index = tab.getAttribute('data-sheet-tab');
        tabs.forEach(function (other) {
          other.setAttribute('aria-selected', String(other === tab));
        });
        panels.forEach(function (panel) {
          panel.hidden = panel.getAttribute('data-sheet-panel') !== index;
        });
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

  // Phones and tablets only; desktop keeps opening files in a new tab.
  const touchLayout = window.matchMedia('(max-width: 760px), (hover: none) and (pointer: coarse)');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  // Full-screen image viewer for the Files page: fits the screen, swipes between images, back button closes it.
  // Pinch-zoom is left to the browser; swipes are ignored while zoomed so panning still works.
  const viewerLinks = Array.from(document.querySelectorAll('[data-viewer-image]'));
  if (viewerLinks.length > 0) {
    let viewer = null;
    let group = [];
    let index = 0;
    let touchStart = null;

    function buildViewer() {
      viewer = document.createElement('div');
      viewer.className = 'image-viewer';
      viewer.setAttribute('role', 'dialog');
      viewer.setAttribute('aria-modal', 'true');
      viewer.setAttribute('aria-label', 'Image viewer');
      viewer.hidden = true;
      viewer.innerHTML =
        '<div class="viewer-bar">' +
        '<button class="viewer-button" type="button" data-viewer-close aria-label="Close">Close</button>' +
        '<div class="viewer-title"><strong data-viewer-name></strong><span data-viewer-count></span></div>' +
        '<a class="viewer-button" data-viewer-open target="_blank" rel="noopener noreferrer">Open</a>' +
        '</div>' +
        '<div class="viewer-stage" data-viewer-stage><img data-viewer-img alt=""></div>' +
        '<div class="viewer-bar viewer-nav">' +
        '<button class="viewer-button" type="button" data-viewer-prev aria-label="Previous image">Prev</button>' +
        '<button class="viewer-button" type="button" data-viewer-next aria-label="Next image">Next</button>' +
        '</div>';
      document.body.appendChild(viewer);

      viewer.querySelector('[data-viewer-close]').addEventListener('click', closeViewer);
      viewer.querySelector('[data-viewer-prev]').addEventListener('click', function () { show(index - 1); });
      viewer.querySelector('[data-viewer-next]').addEventListener('click', function () { show(index + 1); });

      const stage = viewer.querySelector('[data-viewer-stage]');
      stage.addEventListener('touchstart', function (event) {
        touchStart = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
      }, { passive: true });
      stage.addEventListener('touchend', function (event) {
        const zoomed = window.visualViewport && window.visualViewport.scale > 1.05;
        if (!touchStart || zoomed || event.changedTouches.length !== 1) return;
        const dx = event.changedTouches[0].clientX - touchStart.x;
        const dy = event.changedTouches[0].clientY - touchStart.y;
        touchStart = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          show(index + (dx < 0 ? 1 : -1));
        } else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) {
          closeViewer();
        }
      });
    }

    function show(nextIndex) {
      if (nextIndex < 0 || nextIndex >= group.length) return;
      index = nextIndex;
      const link = group[index];
      viewer.querySelector('[data-viewer-img]').src = link.href;
      viewer.querySelector('[data-viewer-img]').alt = link.textContent;
      viewer.querySelector('[data-viewer-name]').textContent = link.textContent;
      viewer.querySelector('[data-viewer-count]').textContent = group.length > 1 ? (index + 1) + ' of ' + group.length : '';
      viewer.querySelector('[data-viewer-open]').href = link.href;
      viewer.querySelector('[data-viewer-prev]').disabled = index === 0;
      viewer.querySelector('[data-viewer-next]').disabled = index === group.length - 1;
      viewer.querySelector('.viewer-nav').hidden = group.length < 2;
    }

    function openViewer(link) {
      if (!viewer) buildViewer();
      const list = link.closest('.files-list');
      group = list ? Array.from(list.querySelectorAll('[data-viewer-image]')) : [link];
      show(group.indexOf(link));
      viewer.hidden = false;
      document.body.classList.add('viewer-open');
      // A history entry lets the phone's back gesture close the viewer instead of leaving the page.
      window.history.pushState({ imageViewer: true }, '');
      viewer.querySelector('[data-viewer-close]').focus();
    }

    function hideViewer() {
      if (!viewer || viewer.hidden) return;
      viewer.hidden = true;
      viewer.querySelector('[data-viewer-img]').removeAttribute('src');
      document.body.classList.remove('viewer-open');
      if (group[index]) group[index].focus();
    }

    function closeViewer() {
      if (window.history.state && window.history.state.imageViewer) {
        window.history.back();
      } else {
        hideViewer();
      }
    }

    window.addEventListener('popstate', hideViewer);

    document.addEventListener('keydown', function (event) {
      if (!viewer || viewer.hidden) return;
      if (event.key === 'Escape') closeViewer();
      if (event.key === 'ArrowLeft') show(index - 1);
      if (event.key === 'ArrowRight') show(index + 1);
    });

    viewerLinks.forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (!touchLayout.matches || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        openViewer(link);
      });
    });
  }

  // Offers "add to home screen" on phones: Android gets an Install button, iOS gets the Share-menu steps.
  const installHint = document.querySelector('[data-install-hint]');
  if (installHint && touchLayout.matches && !isStandalone) {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem('sit-install-dismissed') === '1';
    } catch (_error) {
      // Without storage the hint simply shows again next visit.
    }

    if (!dismissed) {
      const installButton = installHint.querySelector('[data-install-button]');
      const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      let deferredPrompt = null;

      if (isIos) {
        installHint.querySelector('[data-install-text]').textContent =
          'To open Files like an app, tap the Share button, then "Add to Home Screen".';
        installHint.hidden = false;
      }

      window.addEventListener('beforeinstallprompt', function (event) {
        event.preventDefault();
        deferredPrompt = event;
        installButton.hidden = false;
        installHint.hidden = false;
      });

      installButton.addEventListener('click', function () {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () {
          deferredPrompt = null;
          installHint.hidden = true;
        });
      });

      window.addEventListener('appinstalled', function () {
        installHint.hidden = true;
      });

      installHint.querySelector('[data-install-dismiss]').addEventListener('click', function () {
        installHint.hidden = true;
        try {
          window.localStorage.setItem('sit-install-dismissed', '1');
        } catch (_error) {
          // Nothing to remember it in; hiding it for this visit is enough.
        }
      });
    }
  }
})();
