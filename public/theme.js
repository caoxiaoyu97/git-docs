(function () {
  var KEY = 'git-docs:theme';
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  function stored() {
    try { var value = localStorage.getItem(KEY); return value === 'light' || value === 'dark' ? value : null; }
    catch (error) { return null; }
  }
  function apply(value) {
    var theme = value || (media.matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    var button = document.querySelector('#theme-toggle');
    if (button) {
      button.textContent = theme === 'dark' ? '☀ 浅色' : '☾ 深色';
      button.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    }
  }
  apply(stored());
  if (media.addEventListener) media.addEventListener('change', function () { if (!stored()) apply(null); });
  document.addEventListener('DOMContentLoaded', function () {
    var button = document.querySelector('#theme-toggle');
    if (!button) return;
    apply(stored());
    button.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (error) {}
      apply(next);
    });
  });
})();
