/** Copy controls are shared by the landing page and the read-only report viewer. */
export async function copyText(text, button) {
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
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
    const button = event.target.closest("[data-copy-target]");
    const target = button?.dataset.copyTarget &&
        document.getElementById(button.dataset.copyTarget);
    if (button && target)
        void copyText(target.textContent || "", button);
});
