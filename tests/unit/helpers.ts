import { markdownToHtml } from '../../src/markdown/html';

// The <body> contents of a conversion result, without the document frame.
export const body = (md: string) => markdownToHtml(md, 't').split('<body>\n')[1].split('\n</body>')[0];
