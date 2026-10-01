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

  // Top Platform Switcher
  function initPlatformBar() {
    if (document.querySelector('.platform-bar')) return;

    document.body.classList.add('has-platform-bar');

    var currentPath = window.location.pathname.split('/').pop() || 'index.html';
    var db = window.EastGateDB ? window.EastGateDB.get() : null;
    var userRole = db && db.currentUser ? db.currentUser.role : 'CUSTOMER';

    var bar = document.createElement('div');
    bar.className = 'platform-bar';
    bar.innerHTML = [
      '<div class="platform-bar__left">',
      '  <span class="platform-bar__tag">EAST GATE PLATFORM</span>',
      '  <nav class="platform-bar__nav">',
      '    <a href="index.html" class="' + (currentPath === 'index.html' ? 'is-current' : '') + '">Home</a>',
      '    <a href="properties.html" class="' + (currentPath === 'properties.html' ? 'is-current' : '') + '">Properties</a>',
      '    <a href="land.html" class="' + (currentPath === 'land.html' ? 'is-current' : '') + '">Land</a>',
      '    <a href="marketplace.html" class="' + (currentPath === 'marketplace.html' ? 'is-current' : '') + '">Marketplace</a>',
      '    <a href="services.html" class="' + (currentPath === 'services.html' ? 'is-current' : '') + '">Services</a>',
      '    <a href="dealers.html" class="' + (currentPath === 'dealers.html' ? 'is-current' : '') + '">Dealers & Pros</a>',
      '  </nav>',
      '</div>',
      '<div class="platform-bar__right">',
      '  <div class="role-switcher">',
      '    <span>Portal:</span>',
      '    <select id="portalRoleSelect">',
      '      <option value="CUSTOMER" ' + (userRole === 'CUSTOMER' ? 'selected' : '') + '>👤 Customer (Jay)</option>',
      '      <option value="DEALER" ' + (userRole === 'DEALER' ? 'selected' : '') + '>🧑🏾‍💼 Dealer (John Props)</option>',
      '      <option value="ADMIN" ' + (userRole === 'ADMIN' ? 'selected' : '') + '>🛡️ Admin Control Center</option>',
      '    </select>',
      '  </div>',
      '  <a href="' + (userRole === 'ADMIN' ? 'admin.html' : (userRole === 'DEALER' ? 'dealer-dashboard.html' : 'dashboard.html')) + '" class="btn btn--gold btn--sm" style="padding:4px 10px;font-size:0.65rem;" id="portalDirectBtn">Open Portal</a>',
      '</div>'
    ].join('');

    document.body.prepend(bar);

    var select = document.getElementById('portalRoleSelect');
    var portalBtn = document.getElementById('portalDirectBtn');

    if (select) {
      select.addEventListener('change', function (e) {
        var newRole = e.target.value;
        if (window.EastGateDB) {
          window.EastGateDB.switchUser(newRole);
          window.showEastGateToast('Switched persona to: ' + newRole);
          if (portalBtn) {
            portalBtn.href = newRole === 'ADMIN' ? 'admin.html' : (newRole === 'DEALER' ? 'dealer-dashboard.html' : 'dashboard.html');
          }
          // Redirect if currently on a portal page
          if (currentPath.indexOf('dashboard') > -1 || currentPath === 'admin.html') {
            window.location.href = portalBtn.href;
          }
        }
      });
    }
  }

  // Floating WhatsApp CTA
  function initFloatingWhatsApp() {
    if (document.querySelector('.floating-whatsapp')) return;

    var wa = document.createElement('a');
    wa.className = 'floating-whatsapp';
    wa.href = 'https://wa.me/2348031234567?text=Hello%20East%20Gate%20Real-Estate%2C%20I%20am%20inquiring%20about%20a%20property%20listing.';
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
  function initDynamicSearch() {
    var tabs = document.querySelectorAll('.search .tab');
    var priceSelect = document.querySelector('.search select[aria-label="Price range"]');
    if (!tabs.length || !priceSelect) return;

    var priceOptions = {
      Buy: [
        'Any Price',
        'Under ₦20,000,000',
        '₦20,000,000 – ₦50,000,000',
        '₦50,000,000 – ₦120,000,000',
        '₦120,000,000 +'
      ],
      Rent: [
        'Any Rental Price',
        'Under ₦1,500,000 / year',
        '₦1,500,000 – ₦3,500,000 / year',
        '₦3,500,000 – ₦8,000,000 / year',
        '₦8,000,000 + / year'
      ],
      Land: [
        'Any Land Price',
        'Under ₦10,000,000 / plot',
        '₦10,000,000 – ₦30,000,000 / plot',
        '₦30,000,000 – ₦70,000,000 / plot',
        '₦70,000,000 +'
      ]
    };

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var tabName = tab.textContent.trim();
        var options = priceOptions[tabName] || priceOptions.Buy;
        priceSelect.innerHTML = options.map(function (opt) {
          return '<option>' + opt + '</option>';
        }).join('');
      });
    });

    var searchForm = document.querySelector('.search__fields');
    if (searchForm) {
      searchForm.addEventListener('submit', function (e) {
        e.preventDefault();
        window.location.href = 'properties.html';
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
      '    <input type="hidden" id="inspPropId" value="prop_1">',
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
    document.getElementById('inspPropId').value = propId || 'prop_1';
    document.getElementById('inspPropTitle').value = propTitle || 'Modern 4 Bedroom Villa';
    document.getElementById('inspDisplayTitle').value = propTitle || 'Modern 4 Bedroom Villa';
    // set min date to tomorrow
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('inspDate').value = tomorrow.toISOString().split('T')[0];
    modal.classList.add('is-open');
  };

  // Run enhancements on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initPlatformBar();
      initFloatingWhatsApp();
      initSaveButtons();
      initDynamicSearch();
      initInspectionModal();
    });
  } else {
    initPlatformBar();
    initFloatingWhatsApp();
    initSaveButtons();
    initDynamicSearch();
    initInspectionModal();
  }

})();
