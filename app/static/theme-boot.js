// Applies the last theme before the app loads, so a non-default theme does not flash the default one.
try {
  var saved = JSON.parse(localStorage.getItem('uniharn.themeBoot') || 'null');
  if (saved && saved.vars) {
    var root = document.documentElement;
    for (var name in saved.vars) root.style.setProperty(name, saved.vars[name]);
    root.style.colorScheme = saved.appearance;
  }
} catch (e) {}
