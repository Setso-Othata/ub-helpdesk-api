// Shared utilities for UB Help Desk

function getUser() {
  try { return JSON.parse(sessionStorage.getItem('ub_user')); } catch(e) { return null; }
}

function requireStudent() {
  var u = getUser();
  if (!u || u.role !== 'student') { window.location.href = 'index.html'; return null; }
  return u;
}

function requireAdmin() {
  var u = getUser();
  if (!u || u.role !== 'admin') { window.location.href = 'index.html'; return null; }
  return u;
}

function doLogout() {
  sessionStorage.removeItem('ub_user');
  window.location.href = 'index.html';
}

function toggleFaq(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

function drawDonut(canvasId) {
  var c = document.getElementById(canvasId);
  if (!c) return;
  var ctx = c.getContext('2d');
  var vals = [
    { v: 2, col: '#e67e22' },
    { v: 2, col: '#1a7a4a' },
    { v: 1, col: '#c0392b' }
  ];
  var total = 5;
  ctx.clearRect(0, 0, 180, 180);
  var start = -Math.PI / 2;
  vals.forEach(function(v) {
    var sl = (v.v / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(90, 90); ctx.arc(90, 90, 78, start, start + sl);
    ctx.fillStyle = v.col; ctx.fill(); start += sl;
  });
  ctx.beginPath(); ctx.arc(90, 90, 46, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.fillStyle = '#0a1628'; ctx.font = 'bold 20px Arial'; ctx.textAlign = 'center'; ctx.fillText('5', 90, 86);
  ctx.font = '10px Arial'; ctx.fillStyle = '#9a9aac'; ctx.fillText('total', 90, 102);
}

// Student topbar + sidebar HTML
function studentShell(user, activePage) {
  var pages = [
    { id: 'dashboard',   label: 'Dashboard',      href: 'student-dashboard.html',   section: 'Overview' },
    { id: 'credits',     label: 'Extra Credits',   href: 'student-credits.html',     section: 'Submit Request' },
    { id: 'addcourse',   label: 'Add a Course',    href: 'student-addcourse.html',   section: null },
    { id: 'dropcourse',  label: 'Drop a Course',   href: 'student-dropcourse.html',  section: null },
    { id: 'program',     label: 'Change Program',  href: 'student-program.html',     section: null },
    { id: 'pending',     label: 'Pending',         href: 'student-pending.html',     section: 'My Requests' },
    { id: 'approved',    label: 'Approved',        href: 'student-approved.html',    section: null },
    { id: 'denied',      label: 'Denied',          href: 'student-denied.html',      section: null },
    { id: 'faq',         label: 'FAQs',            href: 'student-faq.html',         section: 'Help' },
  ];

  var sidebarHTML = '';
  var currentSection = null;
  pages.forEach(function(p) {
    if (p.section) {
      sidebarHTML += '<div class="sb-section">';
      sidebarHTML += '<div class="sb-label">' + p.section + '</div>';
      currentSection = p.section;
    }
    var cls = (p.id === activePage) ? 'sb-link active' : 'sb-link';
    sidebarHTML += '<a href="' + p.href + '" class="' + cls + '">' + p.label + '</a>';
  });
  sidebarHTML += '</div>';

  return '<div class="topbar">' +
    '<span class="topbar-title">University of Botswana &mdash; Student Help Desk</span>' +
    '<span class="topbar-user">' + (user ? user.name : '') + '</span>' +
    '<a href="index.html" class="topbar-logout" onclick="doLogout();return false;">Log out</a>' +
    '</div>' +
    '<div class="layout">' +
    '<div class="sidebar">' + sidebarHTML + '</div>' +
    '<div class="main">';
}

// Admin topbar + sidebar HTML
function adminShell(user, activePage) {
  var pages = [
    { id: 'dashboard', label: 'Dashboard', href: 'admin-dashboard.html', section: 'Overview' },
    { id: 'pending',   label: 'Pending',   href: 'admin-pending.html',   section: 'Requests' },
    { id: 'approved',  label: 'Approved',  href: 'admin-approved.html',  section: null },
    { id: 'denied',    label: 'Denied',    href: 'admin-denied.html',    section: null },
    { id: 'report',    label: 'Reports',   href: 'admin-report.html',    section: 'Analytics' },
    { id: 'faq',       label: 'FAQs',      href: 'admin-faq.html',       section: 'Help' },
  ];

  var sidebarHTML = '';
  pages.forEach(function(p) {
    if (p.section) {
      sidebarHTML += '<div class="sb-section">';
      sidebarHTML += '<div class="sb-label">' + p.section + '</div>';
    }
    var cls = (p.id === activePage) ? 'sb-link active' : 'sb-link';
    sidebarHTML += '<a href="' + p.href + '" class="' + cls + '">' + p.label + '</a>';
  });
  sidebarHTML += '</div>';

  return '<div class="topbar">' +
    '<span class="topbar-title">University of Botswana &mdash; Student Help Desk</span>' +
    '<span class="topbar-user">' + (user ? user.name : '') + '</span>' +
    '<div class="bell-wrap"><a href="admin-pending.html" class="bell-btn">Alerts</a>' +
    '<span class="bell-count">2</span></div>' +
    '<a href="index.html" class="topbar-logout" onclick="doLogout();return false;">Log out</a>' +
    '</div>' +
    '<div class="layout">' +
    '<div class="sidebar">' + sidebarHTML + '</div>' +
    '<div class="main">';
}
