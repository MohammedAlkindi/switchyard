/**
 * Documentation portal interactive controller
 * Handles search filtering, active heading observation, and clipboard copying.
 */

export async function copyText(
  text: string,
  button: HTMLButtonElement,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const originalText = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = originalText;
    }, 2000);
    const status = document.getElementById("copy-status");
    if (status) status.textContent = "Copied to clipboard.";
  } catch {
    button.textContent = "Failed to copy";
  }
}

// Global click delegation for copy buttons and anchor navigation
document.addEventListener("click", (event) => {
  const target = event.target as Element;
  const copyBtn = target.closest<HTMLButtonElement>("[data-copy-target]");
  if (copyBtn) {
    const targetId = copyBtn.dataset.copyTarget;
    if (targetId) {
      const codeElement = document.getElementById(targetId);
      if (codeElement) {
        void copyText(codeElement.textContent || "", copyBtn);
      }
    }
    return;
  }

  // Handle direct code block copy
  const snippetCopyBtn = target.closest<HTMLButtonElement>(".code-copy-btn");
  if (snippetCopyBtn) {
    const block = snippetCopyBtn.closest(".code-block");
    const pre = block?.querySelector("pre");
    if (pre) {
      void copyText(pre.textContent || "", snippetCopyBtn);
    }
  }
});

// Sidebar search filter
const searchInput = document.getElementById("docs-search") as HTMLInputElement | null;
if (searchInput) {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.toLowerCase().trim();
    const navLinks = document.querySelectorAll<HTMLAnchorElement>(".docs-nav-link");
    const navGroups = document.querySelectorAll<HTMLElement>(".docs-nav-group");

    navLinks.forEach((link) => {
      const text = link.textContent?.toLowerCase() || "";
      const matches = !query || text.includes(query);
      link.parentElement?.style.setProperty("display", matches ? "block" : "none");
    });

    // Hide groups if all children are hidden
    navGroups.forEach((group) => {
      const visibleItems = group.querySelectorAll<HTMLLIElement>("li:not([style*='display: none'])");
      group.style.display = visibleItems.length > 0 ? "block" : "none";
    });
  });
}

// Scroll spy for active sidebar link
if ("IntersectionObserver" in window) {
  const headings = document.querySelectorAll<HTMLElement>(".docs-section h2[id], .docs-section h3[id]");
  const navLinks = new Map<string, HTMLAnchorElement>();

  document.querySelectorAll<HTMLAnchorElement>(".docs-nav-link").forEach((link) => {
    const href = link.getAttribute("href");
    if (href?.startsWith("#")) {
      navLinks.set(href.slice(1), link);
    }
  });

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          navLinks.forEach((link) => link.classList.remove("active"));
          const activeLink = navLinks.get(id);
          if (activeLink) {
            activeLink.classList.add("active");
          }
          break;
        }
      }
    },
    { rootMargin: "0px 0px -70% 0px", threshold: 0.1 }
  );

  headings.forEach((heading) => observer.observe(heading));
}
