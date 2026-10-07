(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. Entrance ---------- */
  window.addEventListener('load', function () {
    requestAnimationFrame(function () {
      document.body.classList.add('is-loaded');
    });
  });
  setTimeout(function () { document.body.classList.add('is-loaded'); }, 900);

  /* ---------- 2. Scroll reveal ---------- */
  var revealEls = document.querySelectorAll('.reveal, .reveal-img, .eco');

  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.12,
      rootMargin: '0px 0px -8% 0px'
    });

    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('is-visible'); });
  }

  /* ---------- 3. Navbar state ---------- */
  var nav = document.getElementById('nav');
  var progress = document.getElementById('progress');
  var heroMedia = document.getElementById('heroMedia');
  var ticking = false;

  function onScroll() {
    var y = window.pageYOffset || document.documentElement.scrollTop;

    if (nav) {
      if (y > 40) { nav.classList.add('is-scrolled'); }
      else { nav.classList.remove('is-scrolled'); }
    }

    if (progress) {
      var docH = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = docH > 0 ? Math.min(y / docH, 1) : 0;
      progress.style.transform = 'scaleX(' + ratio + ')';
    }

    if (!reduceMotion && heroMedia && y < window.innerHeight * 1.4) {
      heroMedia.style.transform = 'translate3d(0,' + (y * 0.16) + 'px,0)';
    }

    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      window.requestAnimationFrame(onScroll);
      ticking = true;
    }
  }, { passive: true });

  onScroll();

  /* ---------- 4. Mobile menu ---------- */
  var burger = document.getElementById('burger');
  var menu = document.getElementById('menu');

  if (burger && menu) {
    var menuLinks = menu.querySelectorAll('.menu__links a');

    function setMenu(open) {
      burger.classList.toggle('is-open', open);
      menu.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      menu.setAttribute('aria-hidden', String(!open));
      document.body.style.overflow = open ? 'hidden' : '';

      menuLinks.forEach(function (link, i) {
        link.style.transitionDelay = open ? (0.08 + i * 0.055) + 's' : '0s';
      });
    }

    burger.addEventListener('click', function () {
      setMenu(!menu.classList.contains('is-open'));
    });

    menuLinks.forEach(function (link) {
      link.addEventListener('click', function () { setMenu(false); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('is-open')) setMenu(false);
    });
  }

  /* ---------- 5. Active nav link on scroll ---------- */
  var sections = [
    { id: 'properties', el: document.getElementById('properties') },
    { id: 'types',      el: document.getElementById('types') },
    { id: 'ecosystem',  el: document.getElementById('ecosystem') },
    { id: 'agents',     el: document.getElementById('agents') },
    { id: 'marketplace',el: document.getElementById('marketplace') }
  ];
  var navLinks = document.querySelectorAll('.nav__links a');

  if ('IntersectionObserver' in window) {
    var navIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var match = sections.filter(function (s) { return s.el === entry.target; })[0];
        if (!match) return;
        navLinks.forEach(function (a) {
          a.classList.toggle('is-active', a.getAttribute('href') === '#' + match.id);
        });
      });
    }, { threshold: 0.25, rootMargin: '-20% 0px -55% 0px' });

    sections.forEach(function (s) { if (s.el) navIO.observe(s.el); });
  }

  /* ============================================================
     EAST GATE PLATFORM ENHANCEMENTS
     ============================================================ */

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function firstName(fullName) {
    return String(fullName || '').trim().split(/\s+/)[0] || 'Guest';
  }

  function roleLabel(role) {
    switch (role) {
      case 'ADMIN':
      case 'SUPER_ADMIN':
        return 'Admin';
      case 'DEALER':
        return 'Dealer';
      default:
        return 'Customer';
    }
  }

  // Toast System
  window.showEastGateToast = function (message) {
    var toast = document.getElementById('eastToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'eastToast';
      toast.className = 'east-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> ' + message;
    toast.classList.add('is-shown');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(function () {
      toast.classList.remove('is-shown');
    }, 3500);
  };

  // Rewrites the header sign-in links: signed out → login with a return path,
  // signed in → straight to the portal that matches the account role.
  function initAuthNav() {
    var links = document.querySelectorAll('.nav__signin');
    if (!links.length) return;

    var auth = window.EastGateAuth;
    var session = auth ? auth.getSession() : null;

    Array.prototype.forEach.call(links, function (link) {
      if (session) {
        link.href = auth.landingForRole(session.role);
        link.textContent = 'My Portal';
        link.setAttribute('title', 'Signed in as ' + session.name + ' (' + roleLabel(session.role) + ')');
        link.classList.add('is-authenticated');
      } else {
        link.href = auth ? auth.loginUrlFor() : 'login.html';
        link.textContent = 'Sign In';
        link.removeAttribute('title');
        link.classList.remove('is-authenticated');
      }
    });

    // Plain `login.html` links (header CTAs, footer links) should also carry
    // a return path so sign-in lands back on the page the visitor came from.
    if (!session && auth) {
      var plainLinks = document.querySelectorAll('a[href="login.html"]');
      Array.prototype.forEach.call(plainLinks, function (link) {
        link.href = auth.loginUrlFor();
      });
    }
  }

  // Log-out control — rendered only for a visitor who is signed in.
  //
  // `EastGateAuth.logout()` existed but nothing in the UI ever called it, so a
  // session could only be ended by clearing browser storage by hand. A button
  // is now dropped next to every sign-in link (header actions and the mobile
  // menu foot) and into each portal sidebar footer; clicking it posts
  // /api/auth/logout, clears the session, and sends the visitor home.
  function initLogoutControls() {
    var auth = window.EastGateAuth;
    var session = auth ? auth.getSession() : null;
    if (!auth || !session) return;

    function makeLogout(className) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.textContent = 'Log Out';
      btn.setAttribute('aria-label', 'Sign out of ' + session.name);
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'Signing out…';
        auth.logout().then(function () {
          window.location.href = 'index.html';
        });
      });
      return btn;
    }

    // Public pages: beside each sign-in link — header actions and menu foot.
    var signInLinks = document.querySelectorAll('.nav__signin');
    Array.prototype.forEach.call(signInLinks, function (link) {
      if (link.nextElementSibling && link.nextElementSibling.classList.contains('nav__signout')) return;
      link.parentNode.insertBefore(makeLogout('nav__signout'), link.nextSibling);
    });

    // Portal pages: under the sidebar's "visit the live platform" link.
    var sidebar = document.querySelector('.portal-sidebar');
    if (sidebar && !sidebar.querySelector('.portal-logout')) {
      var foot = sidebar.lastElementChild;
      (foot || sidebar).appendChild(makeLogout('portal-logout'));
    }
  }

  // Admin access badge — fixed in the bottom-left corner of the page.
  //
  // Rendered ONLY for a visitor who is already signed in as an admin. It used to
  // also appear for signed-out visitors (linking to login.html?next=admin.html)
  // and for non-admins, which turned every public page into a signpost to the
  // most privileged account on the platform.
  //
  // There is now no link to the admin console anywhere in the public UI. The
  // console is reachable only by typing admin.html directly — an unlisted URL.
  // That is obscurity, not access control: admin.html is still role-guarded by
  // the server, and this badge is a convenience for an admin who is signed in.
  function initAdminBadge() {
    if (document.querySelector('.admin-badge')) return;

    var auth = window.EastGateAuth;
    var session = auth ? auth.getSession() : null;
    var isAdmin = session && (session.role === 'ADMIN' || session.role === 'SUPER_ADMIN');

    // Everyone who is not already an admin gets no badge at all.
    if (!isAdmin) return;

    var badge = document.createElement('a');
    badge.className = 'admin-badge admin-badge--active';
    badge.href = 'admin.html';
    badge.title = 'Open the East Gate admin console';
    badge.setAttribute('aria-label', 'Open the admin console');

    badge.innerHTML = [
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      '</svg>',
      '<span>Admin</span>',
      '<span class="admin-badge__dot" aria-hidden="true"></span>'
    ].join('');

    document.body.appendChild(badge);
  }

  // Floating WhatsApp CTA
  function initFloatingWhatsApp() {
    if (document.querySelector('.floating-whatsapp')) return;

    var wa = document.createElement('a');
    wa.className = 'floating-whatsapp';
    wa.href = 'https://wa.me/2348108990239?text=Hello%20East%20Gate%20Real-Estate%2C%20I%20am%20inquiring%20about%20a%20property%20listing.';
    wa.target = '_blank';
    wa.rel = 'noopener noreferrer';
    wa.setAttribute('aria-label', 'Contact East Gate on WhatsApp');
    wa.innerHTML = [
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">',
      '  <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0 0 12.04 2zm.01 1.67c2.2 0 4.26.86 5.82 2.42a8.225 8.225 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.24 8.24-1.42 0-2.82-.37-4.06-1.07l-.29-.17-3.12.82.83-3.04-.19-.31a8.19 8.19 0 0 1-1.25-4.47c0-4.54 3.7-8.24 8.24-8.24zm4.52 11.66c-.25-.13-1.47-.72-1.7-.81-.23-.08-.39-.13-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.13-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.39-1.72-.14-.25-.02-.39.11-.51.11-.11.25-.29.38-.44.13-.14.17-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.35-.77-1.85-.2-.49-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1 0 1.24.9 2.44 1.03 2.61.13.17 1.78 2.71 4.3 3.8.6.26 1.07.41 1.43.53.6.19 1.15.16 1.58.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.15-1.18-.06-.11-.23-.17-.48-.29z"/>',
      '</svg>',
      '<span>WhatsApp Inquiry</span>'
    ].join('');

    document.body.appendChild(wa);
  }

  // Save/Bookmark Heart Click Handling
  function initSaveButtons() {
    var saveBtns = document.querySelectorAll('.prop-card__save');
    saveBtns.forEach(function (btn, index) {
      var propId = btn.getAttribute('data-id') || ('prop_' + (index + 1));
      btn.setAttribute('data-id', propId);

      // Check current state from DB
      if (window.EastGateDB && window.EastGateDB.isPropertySaved(propId)) {
        btn.classList.add('is-saved');
        btn.style.background = '#C6A15B';
        btn.style.color = '#111';
      }

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (window.EastGateDB) {
          var saved = window.EastGateDB.toggleSaveProperty(propId);
          if (saved) {
            btn.classList.add('is-saved');
            btn.style.background = '#C6A15B';
            btn.style.color = '#111';
            window.showEastGateToast('Property saved to your Customer Portal');
          } else {
            btn.classList.remove('is-saved');
            btn.style.background = '';
            btn.style.color = '';
            window.showEastGateToast('Property removed from saved listings');
          }
        }
      });
    });
  }

  // Dynamic Search Tabs
  //
  // The Buy/Rent/Land tabs narrow the Purpose dropdown to the purposes that make
  // sense for that axis, and Search hands the chosen purpose to properties.html.
  function initDynamicSearch() {
    var tabs = document.querySelectorAll('.search .tab');
    var purposeSelect = document.querySelector('.search select[aria-label="Purpose"]');
    if (!tabs.length || !purposeSelect) return;

    // Read the value/label pairs out of the markup that is already in the page so
    // this function never carries its own copy of the vocabulary. index.html is
    // the fallback for when the API is unreachable, so the two must agree.
    var allOptions = [];
    Array.prototype.forEach.call(purposeSelect.options, function (option) {
      if (option.value && option.value !== 'ALL') {
        allOptions.push({ value: option.value, label: option.textContent });
      }
    });
    if (!allOptions.length) return;

    var anyLabel = purposeSelect.options[0] ? purposeSelect.options[0].textContent : 'Any Purpose';
    var anyOption = { value: 'ALL', label: anyLabel };

    // Grouped by the axis each tab represents. A purpose missing from a group is
    // simply not offered under that tab.
    var byTab = {
      Buy: ['BUY', 'DISTRESS_SALE', 'JOINT_VENTURE', 'LAND_BANKING'],
      Rent: ['SHORT_LET', 'LONG_LET', 'STAFF_QUARTERS'],
      Land: ['LAND_BANKING', 'BUY', 'LONG_LEASE', 'JOINT_VENTURE']
    };

    function applyTab(tabName) {
      var allowed = byTab[tabName];
      var options = [anyOption];

      // An unrecognised tab name must not leave the visitor with a one-option
      // dropdown, so fall back to the full list.
      if (allowed) {
        allOptions.forEach(function (option) {
          if (allowed.indexOf(option.value) !== -1) options.push(option);
        });
      }
      if (options.length === 1) options = [anyOption].concat(allOptions);

      purposeSelect.innerHTML = options.map(function (option) {
        return '<option value="' + escapeHtml(option.value) + '">' + escapeHtml(option.label) + '</option>';
      }).join('');
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (other) {
          other.classList.remove('is-active');
          other.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('is-active');
        tab.setAttribute('aria-selected', 'true');
        applyTab(tab.textContent.trim());
      });
    });

    // Keep the dropdown consistent with the tab that starts out active.
    var activeTab = document.querySelector('.search .tab.is-active');
    applyTab(activeTab ? activeTab.textContent.trim() : 'Buy');

    var searchForm = document.querySelector('.search__fields');
    if (searchForm) {
      searchForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var purpose = purposeSelect.value;
        var query = purpose && purpose !== 'ALL' ? '?purpose=' + encodeURIComponent(purpose) : '';
        window.location.href = 'properties.html' + query;
      });
    }
  }

  // Global Inspection Modal Setup
  function initInspectionModal() {
    if (document.getElementById('inspectionModal')) return;

    var modal = document.createElement('div');
    modal.id = 'inspectionModal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = [
      '<div class="modal-box">',
      '  <div class="modal-box__head">',
      '    <h3 class="modal-box__title">Schedule Property Inspection</h3>',
      '    <button class="modal-box__close" id="closeInspectionModal">&times;</button>',
      '  </div>',
      '  <p style="font-size:0.84rem;color:var(--ivory-62);margin-bottom:20px;">Book a verified on-site inspection with the certified dealer. An East Gate agent will accompany your walkthrough.</p>',
      '  <form id="inspectionForm">',
      '    <input type="hidden" id="inspPropId" value="">',
      '    <input type="hidden" id="inspPropTitle" value="Modern 4 Bedroom Villa">',
      '    <div class="form-group">',
      '      <label class="form-label">Property</label>',
      '      <input type="text" class="form-input" id="inspDisplayTitle" readonly style="opacity:0.8;">',
      '    </div>',
      '    <div class="form-group">',
      '      <label class="form-label">Preferred Date</label>',
      '      <input type="date" class="form-input" id="inspDate" required>',
      '    </div>',
      '    <div class="form-group">',
      '      <label class="form-label">Preferred Time Slot</label>',
      '      <select class="form-select" id="inspTime">',
      '        <option>10:00 AM – 11:30 AM</option>',
      '        <option selected>02:00 PM – 03:30 PM</option>',
      '        <option>04:30 PM – 06:00 PM</option>',
      '      </select>',
      '    </div>',
      '    <div class="form-group">',
      '      <label class="form-label">Special Inquiries or Instructions</label>',
      '      <textarea class="form-textarea" id="inspNotes" rows="3" placeholder="e.g., Requesting physical survey beacon inspection, structural review, or engineer accompaniment..."></textarea>',
      '    </div>',
      '    <button type="submit" class="btn btn--gold" style="width:100%;margin-top:10px;">Confirm & Book Appointment</button>',
      '  </form>',
      '</div>'
    ].join('');

    document.body.appendChild(modal);

    var closeBtn = document.getElementById('closeInspectionModal');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        modal.classList.remove('is-open');
      });
    }

    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.classList.remove('is-open');
    });

    var form = document.getElementById('inspectionForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var date = document.getElementById('inspDate').value;
        var time = document.getElementById('inspTime').value;
        var notes = document.getElementById('inspNotes').value;
        var propId = document.getElementById('inspPropId').value;
        var propTitle = document.getElementById('inspPropTitle').value;

        if (window.EastGateDB) {
          window.EastGateDB.bookInspection({
            propertyId: propId,
            propertyTitle: propTitle,
            propertyLocation: 'Aba, Abia State',
            date: date,
            time: time,
            notes: notes
          });
          modal.classList.remove('is-open');
          window.showEastGateToast('Inspection confirmed! Added to your User Dashboard.');
        }
      });
    }
  }

  window.openInspectionModal = function (propId, propTitle) {
    var modal = document.getElementById('inspectionModal');
    if (!modal) return;
    document.getElementById('inspPropId').value = propId || '';
    document.getElementById('inspPropTitle').value = propTitle || 'Property';
    document.getElementById('inspDisplayTitle').value = propTitle || 'Property';
    // set min date to tomorrow
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('inspDate').value = tomorrow.toISOString().split('T')[0];
    modal.classList.add('is-open');
  };

  /* ---------- Property photo gallery ---------- */
  /**
   * Assembles the photo list for one listing from the API/local record.
   *
   * `cover` (the record's mainImage) is forced to the front so the lightbox
   * opens on exactly the image the card shows, and duplicates are dropped.
   * Lives here rather than in each page so properties.html, land.html and any
   * future catalogue page cannot drift apart on the ordering rule.
   */
  window.propertyGallery = function (raw, cover) {
    var source = raw || {};
    var list = Array.isArray(source.galleryImages)
      ? source.galleryImages
      : (Array.isArray(source.gallery) ? source.gallery : []);

    var seen = {};
    var images = [];

    if (cover) {
      images.push(cover);
      seen[cover] = true;
    }

    list.forEach(function (src) {
      if (typeof src !== 'string' || !src || seen[src]) return;
      seen[src] = true;
      images.push(src);
    });

    return images;
  };

  var galleryState = { images: [], index: 0, opener: null };

  function closeGallery() {
    var shell = document.getElementById('propertyGallery');
    if (!shell || !shell.classList.contains('is-open')) return;

    shell.classList.remove('is-open');
    document.body.style.overflow = '';
    if (galleryState.opener && galleryState.opener.focus) galleryState.opener.focus();
  }

  function showGalleryImage(index) {
    var images = galleryState.images;
    if (!images.length) return;

    galleryState.index = ((index % images.length) + images.length) % images.length;

    var stage = document.getElementById('galleryStageImg');
    var counter = document.getElementById('galleryCounter');
    if (stage) {
      stage.src = images[galleryState.index];
      stage.alt = 'Property photo ' + (galleryState.index + 1) + ' of ' + images.length;
    }
    if (counter) {
      counter.textContent = 'Photo ' + (galleryState.index + 1) + ' of ' + images.length;
    }

    var thumbs = document.querySelectorAll('#galleryThumbs .gallery-lightbox__thumb');
    thumbs.forEach(function (thumb, i) {
      thumb.classList.toggle('is-active', i === galleryState.index);
    });
  }

  function stepGallery(delta) {
    showGalleryImage(galleryState.index + delta);
  }

  function ensureGallery() {
    if (document.getElementById('propertyGallery')) return;

    var shell = document.createElement('div');
    shell.id = 'propertyGallery';
    shell.className = 'gallery-lightbox';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', 'Property photos');
    shell.innerHTML = [
      '<button type="button" class="gallery-lightbox__close" id="galleryCloseBtn" data-gallery="close" aria-label="Close gallery">&times;</button>',
      '<button type="button" class="gallery-lightbox__nav gallery-lightbox__nav--prev" data-gallery="prev" aria-label="Previous photo">',
      '  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 5l-7 7 7 7"/></svg>',
      '</button>',
      '<figure class="gallery-lightbox__stage">',
      '  <img id="galleryStageImg" src="" alt="">',
      '  <figcaption class="gallery-lightbox__caption" id="galleryCounter"></figcaption>',
      '</figure>',
      '<button type="button" class="gallery-lightbox__nav gallery-lightbox__nav--next" data-gallery="next" aria-label="Next photo">',
      '  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5l7 7-7 7"/></svg>',
      '</button>',
      '<div class="gallery-lightbox__thumbs" id="galleryThumbs"></div>'
    ].join('');

    document.body.appendChild(shell);

    shell.addEventListener('click', function (e) {
      var control = e.target && e.target.closest ? e.target.closest('[data-gallery]') : null;
      if (control) {
        var action = control.getAttribute('data-gallery');
        if (action === 'close') closeGallery();
        else if (action === 'prev') stepGallery(-1);
        else if (action === 'next') stepGallery(1);
        else if (action === 'pick') showGalleryImage(Number(control.getAttribute('data-index')));
        return;
      }
      // Clicks on the shell itself — i.e. the dark backdrop — dismiss it.
      if (e.target === shell) closeGallery();
    });

    document.addEventListener('keydown', function (e) {
      if (!shell.classList.contains('is-open')) return;
      if (e.key === 'Escape') closeGallery();
      else if (e.key === 'ArrowRight') stepGallery(1);
      else if (e.key === 'ArrowLeft') stepGallery(-1);
    });
  }

  /**
   * Opens the full-screen gallery for a listing's photos.
   *
   * @param {string[]} images cover-first list from window.propertyGallery
   * @param {number} [startIndex] which photo to show first
   */
  window.openPropertyGallery = function (images, startIndex) {
    var list = (images || []).filter(function (src) { return typeof src === 'string' && src; });
    if (!list.length) return;

    ensureGallery();

    galleryState.images = list;
    galleryState.opener = document.activeElement;

    var shell = document.getElementById('propertyGallery');
    var thumbs = document.getElementById('galleryThumbs');

    thumbs.innerHTML = list.map(function (src, i) {
      return [
        '<button type="button" class="gallery-lightbox__thumb" data-gallery="pick" data-index="' + i + '">',
        '  <img src="' + src.replace(/"/g, '&quot;') + '" alt="Photo ' + (i + 1) + '">',
        '</button>'
      ].join('');
    }).join('');

    // One photo is not a gallery — hide the strip and the arrows rather than
    // presenting controls that do nothing.
    thumbs.hidden = list.length < 2;
    shell.querySelectorAll('.gallery-lightbox__nav').forEach(function (nav) {
      nav.hidden = list.length < 2;
    });

    shell.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    showGalleryImage(Number(startIndex) || 0);

    var closeBtn = document.getElementById('galleryCloseBtn');
    if (closeBtn) closeBtn.focus();
  };

  // Run enhancements on DOM ready
  var wantsChrome = document.body.getAttribute('data-portal-chrome') !== 'off';

  function initAll() {
    if (wantsChrome) initAdminBadge();
    if (wantsChrome) initFloatingWhatsApp();
    initAuthNav();
    initLogoutControls();
    initSaveButtons();
    initDynamicSearch();
    initInspectionModal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

})();
