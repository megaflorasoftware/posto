declare module "picomatch" {
  interface PicomatchOptions {
    dot?: boolean;
    nocase?: boolean;
  }

  type Matcher = (value: string) => boolean;

  export default function picomatch(
    pattern: string | string[],
    options?: PicomatchOptions,
  ): Matcher;
}
