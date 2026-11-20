export function fitOpenSlideTitle(element: HTMLElement, storedSize: string): void {
  element.style.fontSize = storedSize;
  const content = element.querySelector("textarea") ?? element;
  if (!content.clientHeight || !content.clientWidth) {
    return;
  }
  const overflows = () => content.scrollHeight > content.clientHeight || content.scrollWidth > content.clientWidth;
  if (!overflows()) {
    return;
  }
  let low = 0;
  let high = Number.parseFloat(getComputedStyle(element).fontSize);
  for (let step = 0; step < 16; step += 1) {
    const size = (low + high) / 2;
    element.style.fontSize = `${size}px`;
    if (overflows()) {
      high = size;
    } else {
      low = size;
    }
  }
  element.style.fontSize = `${low}px`;
}
