/* Paper page interactions: theme toggle, copy BibTeX, print, nav highlighting.
   No dependencies; the page reads fine with JavaScript disabled (in light). */

(function () {
  "use strict";

  var THEME_KEY = "eegbench-paper-theme";

  function initTheme() {
    var root = document.documentElement;
    // The <head> script already resolved the theme (light by default); this
    // only wires the toggle and remembers the reader's choice.
    if (root.dataset.theme !== "dark") root.dataset.theme = "light";

    var button = document.getElementById("theme-toggle");
    if (!button) return;
    button.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch (err) {
        /* private mode: the choice simply does not persist */
      }
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // file:// or an older browser: fall back to a hidden textarea.
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy") ? resolve() : reject(new Error("copy failed"));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  function initCopy() {
    document.querySelectorAll("[data-copy-target]").forEach(function (button) {
      button.addEventListener("click", function () {
        var target = document.querySelector(button.getAttribute("data-copy-target"));
        if (!target) return;
        var original = button.textContent;
        copyText(target.innerText.trim()).then(
          function () {
            button.textContent = "Copied";
            button.classList.add("is-done");
            window.setTimeout(function () {
              button.textContent = original;
              button.classList.remove("is-done");
            }, 1800);
          },
          function () {
            button.textContent = "Press Ctrl+C";
            window.setTimeout(function () {
              button.textContent = original;
            }, 1800);
          }
        );
      });
    });
  }

  function initPrint() {
    document.querySelectorAll("[data-print]").forEach(function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        window.print();
      });
    });
  }

  function initScrollSpy() {
    var links = Array.prototype.slice.call(
      document.querySelectorAll(".topbar nav a[href^='#']")
    );
    var sections = links
      .map(function (link) {
        return document.querySelector(link.getAttribute("href"));
      })
      .filter(Boolean);
    if (!sections.length || !("IntersectionObserver" in window)) return;

    var visible = new Map();
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          visible.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
        });
        var best = null;
        visible.forEach(function (ratio, id) {
          if (ratio > 0 && (best === null || ratio > best.ratio)) {
            best = { id: id, ratio: ratio };
          }
        });
        links.forEach(function (link) {
          link.classList.toggle(
            "is-current",
            !!best && link.getAttribute("href") === "#" + best.id
          );
        });
      },
      { rootMargin: "-72px 0px -60% 0px", threshold: [0, 0.25, 0.5, 1] }
    );
    sections.forEach(function (section) {
      observer.observe(section);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    initCopy();
    initPrint();
    initScrollSpy();
  });
})();
