// Vitest test bootstrap. Mocks browser globals not available in jsdom.
import "@testing-library/jest-dom/vitest";

// matchMedia stub for theme resolution in settings tests.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
