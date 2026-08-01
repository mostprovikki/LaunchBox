/* LaunchBox theme bootstrap — dark is the default; the choice persists.
   Loaded synchronously in <head> so the attribute is set before first paint. */
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('lb-theme') || 'dark'; } catch (e) {}
  document.documentElement.dataset.theme = t;
  window.lbToggleTheme = function () {
    var n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = n;
    try { localStorage.setItem('lb-theme', n); } catch (e) {}
  };
})();
