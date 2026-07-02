import "solid-js";

type WaElement = Record<string, any>;

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-button": WaElement;
      "wa-split-panel": WaElement;
      "wa-details": WaElement;
      "wa-spinner": WaElement;
      "wa-callout": WaElement;
    }
  }
}
