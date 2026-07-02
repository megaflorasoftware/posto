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
      "wa-tab-group": WaElement;
      "wa-tab": WaElement;
      "wa-tab-panel": WaElement;
      "wa-input": WaElement;
      "wa-textarea": WaElement;
      "wa-select": WaElement;
      "wa-option": WaElement;
      "wa-switch": WaElement;
      "wa-dialog": WaElement;
    }
  }
}
