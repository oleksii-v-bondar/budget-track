import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../shared/http';

interface Fetcher {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/** Drives a Hono app like a browser: keeps cookies and sends the CSRF header. */
export class TestClient {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly app: Fetcher) {}

  get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send('GET', path, undefined, headers);
  }

  post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.send('POST', path, body, headers);
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async send(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers = new Headers();
    if (method !== 'GET' && method !== 'HEAD') headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    const response = await this.app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) this.storeCookie(header);
    return response;
  }

  private storeCookie(header: string): void {
    const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const expired = attributes.some((a) => /^max-age=0$/i.test(a)) || value === '';
    if (expired) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}
