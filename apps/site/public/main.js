/** Copy controls and interactive elements shared by the landing page and reports. */
export async function copyText(text, button) {
    try {
        await navigator.clipboard.writeText(text);
        const originalText = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => {
            button.textContent = originalText;
        }, 2000);
        document
            .getElementById("copy-status")
            ?.replaceChildren(document.createTextNode("Copied to clipboard."));
    }
    catch {
        button.textContent = "Select & copy manually";
        const target = button.dataset.copyTarget &&
            document.getElementById(button.dataset.copyTarget);
        if (target) {
            const range = document.createRange();
            range.selectNodeContents(target);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
        }
    }
}
document.addEventListener("click", (event) => {
    const target = event.target;
    // Handle data-copy-target buttons
    const copyButton = target.closest("[data-copy-target]");
    if (copyButton) {
        const codeTarget = copyButton.dataset.copyTarget &&
            document.getElementById(copyButton.dataset.copyTarget);
        if (codeTarget) {
            void copyText(codeTarget.textContent || "", copyButton);
        }
        return;
    }
    // Handle terminal / showcase tab switcher
    const tabBtn = target.closest("[data-tab-target]");
    if (tabBtn) {
        const targetId = tabBtn.dataset.tabTarget;
        const tabContainer = tabBtn.closest("[data-tabs]");
        if (!tabContainer || !targetId)
            return;
        tabContainer.querySelectorAll("[data-tab-target]").forEach((btn) => {
            btn.setAttribute("aria-selected", btn === tabBtn ? "true" : "false");
        });
        tabContainer.querySelectorAll("[data-panel-id]").forEach((panel) => {
            const match = panel.dataset.panelId === targetId;
            panel.setAttribute("aria-hidden", match ? "false" : "true");
        });
    }
});
