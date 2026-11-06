import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true }).disable('image');
export const richText = (value: string) => markdown.render(value);
