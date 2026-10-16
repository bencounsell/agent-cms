/* Dependency-free site search: filters the JSON index agentcms writes for the search collection. */
(function () {
  var form = document.querySelector("[data-site-search]");
  if (!form) return;
  var input = form.querySelector("input");
  var results = form.querySelector(".site-search__results");
  var index = null;
  function load() {
    if (index) return Promise.resolve(index);
    return fetch(form.getAttribute("data-index")).then(function (r) { return r.json(); }).then(function (j) { index = j.entries || []; return index; });
  }
  function render(items, q) {
    results.innerHTML = "";
    if (!q || !items.length) { results.hidden = true; return; }
    items.slice(0, 8).forEach(function (e) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = e.path;
      a.textContent = e.title;
      var s = document.createElement("small");
      s.textContent = e.description || "";
      a.appendChild(s);
      li.appendChild(a);
      results.appendChild(li);
    });
    results.hidden = false;
  }
  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    if (!q) { render([], q); return; }
    load().then(function (items) {
      var terms = q.split(/\s+/);
      var hits = items.filter(function (e) {
        var hay = (e.title + " " + (e.description || "") + " " + (e.tags || []).join(" ") + " " + (e.category || "")).toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) !== -1; });
      });
      render(hits, q);
    });
  });
  form.addEventListener("submit", function (ev) { ev.preventDefault(); });
  document.addEventListener("click", function (ev) { if (!form.contains(ev.target)) results.hidden = true; });
})();
