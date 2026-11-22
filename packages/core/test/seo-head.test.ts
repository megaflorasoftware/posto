import { describe, expect, test } from "vitest";
import { decodeEntities, parseSeoHead, truncateSeoText } from "../src/seo/head";

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <!-- <title>Commented out</title> <meta name="description" content="no"> -->
  <title>
    Hello &amp; welcome &#8212; Posto&#39;s blog
  </title>
  <meta name="description" content="  A post about &quot;things&quot;.  ">
  <meta property="og:title" content='Open &amp; Graph'>
  <meta property="og:description" content="OG description">
  <meta property="og:image" content="/images/cover.png?w=1200&h=630">
  <meta property="og:url" content=https://example.com/blog/hello/>
  <meta property="og:site_name" content="Example">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:image" content="https://cdn.example.com/x.jpg">
  <link rel="Canonical" href="https://example.com/blog/hello/">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="/favicon.ico">
  <script>document.write('<meta name="twitter:title" content="from script">')</script>
  <style>/* <meta property="og:title" content="from style"> */</style>
</head>
<body><svg><title>Logo</title></svg></body>
</html>`;

describe("parseSeoHead", () => {
  test("reads the head the way DOMParser does", () => {
    expect(parseSeoHead(PAGE)).toEqual({
      title: "Hello & welcome — Posto's blog",
      description: 'A post about "things".',
      ogTitle: "Open & Graph",
      ogDescription: "OG description",
      ogImage: "/images/cover.png?w=1200&h=630",
      ogUrl: "https://example.com/blog/hello/",
      ogSiteName: "Example",
      twitterCard: "summary",
      twitterTitle: null,
      twitterDescription: null,
      twitterImage: "https://cdn.example.com/x.jpg",
      canonical: "https://example.com/blog/hello/",
      favicon: "/favicon.svg",
    });
  });

  test("takes the first matching element, even when it is empty", () => {
    const seo = parseSeoHead(
      `<title></title><title>Second</title>
       <meta name="description" content="">
       <meta name="description" content="Second">
       <meta property="og:title">`,
    );
    expect(seo.title).toBeNull();
    expect(seo.description).toBeNull();
    expect(seo.ogTitle).toBeNull();
  });

  test("matches names and properties exactly but rel case-insensitively", () => {
    const seo = parseSeoHead(
      `<META NAME="Description" CONTENT="wrong case"><meta name="description" content="right">
       <LINK REL="SHORTCUT ICON" HREF="/icon.png">`,
    );
    expect(seo.description).toBe("right");
    expect(seo.favicon).toBe("/icon.png");
  });

  test("handles quotes, '>' in values and unterminated markup", () => {
    expect(parseSeoHead(`<meta name="description" content="a > b">`).description).toBe("a > b");
    expect(parseSeoHead(`<meta name=description content=plain>`).description).toBe("plain");
    expect(parseSeoHead(`<title>Unclosed`).title).toBe("Unclosed");
    expect(parseSeoHead(`<!-- never closed <title>x</title>`).title).toBeNull();
    expect(parseSeoHead(``)).toMatchObject({ title: null, favicon: null, canonical: null });
  });

  test("ignores metadata inside templates", () => {
    const seo = parseSeoHead(
      `<template><meta name="description" content="templated"></template><meta name="description" content="real">`,
    );
    expect(seo.description).toBe("real");
  });

  test("parses empty and bang-closed comments as HTML does", () => {
    const seo = parseSeoHead(
      `<!--><title>A</title><meta name="description" content="d"><!-- x -->`,
    );
    expect(seo.title).toBe("A");
    expect(seo.description).toBe("d");
    expect(parseSeoHead(`<!---><title>B</title>`).title).toBe("B");
    expect(parseSeoHead(`<!-- a --!><title>C</title>`).title).toBe("C");
  });

  test("decodes attributes without breaking query strings", () => {
    const seo = parseSeoHead(
      `<title>&frac12; price&excl;</title><link rel="canonical" href="/?a=1&copy=2&amp;b=&frac12;">`,
    );
    expect(seo.title).toBe("½ price!");
    expect(seo.canonical).toBe("/?a=1&copy=2&b=½");
  });

  test("skips many scripts and styles", () => {
    const filler = "<script>let a = '<title>no</title>';</script><STYLE>p{}</STYLE>".repeat(2000);
    const seo = parseSeoHead(`<head>${filler}<title>After</title></head>`);
    expect(seo.title).toBe("After");
  });

  test("keeps the first of repeated attributes", () => {
    expect(parseSeoHead(`<meta name="description" content="one" content="two">`).description).toBe(
      "one",
    );
  });
});

describe("decodeEntities", () => {
  test("decodes numeric, named and legacy references", () => {
    expect(decodeEntities("&#x27;&#39;&#150;&eacute;&nbsp;&amp")).toBe("''–é &");
    expect(decodeEntities("&frac12;&Scaron;&oelig; &eacute")).toBe("½Šœ é");
    // In text, unlike attributes, legacy names decode before `=` and letters.
    expect(decodeEntities("&unknown; &copy=1 &ampx")).toBe("&unknown; ©=1 &x");
    expect(decodeEntities("&#0;&#x110000;")).toBe("��");
  });
});

describe("truncateSeoText", () => {
  test("clips with an ellipsis", () => {
    expect(truncateSeoText("short", 10)).toBe("short");
    expect(truncateSeoText("a long title here", 8)).toBe("a long…");
  });
});
