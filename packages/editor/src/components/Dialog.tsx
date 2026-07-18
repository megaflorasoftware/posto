import { createContext, useContext, type ReactNode } from "react";
import { Drawer, Modal, type ModalProps } from "@mantine/core";

type DialogVariant = "modal" | "drawer";

const DialogVariantContext = createContext<DialogVariant>("modal");

/** Shells choose how shared dialogs present: desktop keeps centered modals,
 * mobile wraps its tree so they open as bottom drawers. */
export function DialogVariantProvider(props: { variant: DialogVariant; children: ReactNode }) {
  return (
    <DialogVariantContext.Provider value={props.variant}>
      {props.children}
    </DialogVariantContext.Provider>
  );
}

type Props = {
  opened: boolean;
  onClose: () => void;
  title?: ReactNode;
  size?: ModalProps["size"];
  children: ReactNode;
};

/** Centered modal or bottom drawer, per the shell's DialogVariantProvider. */
export function Dialog(props: Props) {
  const variant = useContext(DialogVariantContext);
  if (variant === "drawer") {
    return (
      <Drawer
        opened={props.opened}
        onClose={props.onClose}
        title={props.title}
        position="bottom"
        offset={8}
        radius="md"
        styles={{
          // Bottom sheet: hug the content instead of Drawer's fixed height,
          // capped so tall content scrolls inside the body.
          content: {
            height: "auto",
            maxHeight: "calc(100dvh - 16px)",
            display: "flex",
            flexDirection: "column",
          },
          body: { overflowY: "auto" },
        }}
      >
        {props.children}
      </Drawer>
    );
  }
  return (
    <Modal opened={props.opened} onClose={props.onClose} title={props.title} size={props.size}>
      {props.children}
    </Modal>
  );
}
