/**
 * VocaFuse HTTP Client
 * 
 * HTTP client with retry logic, error handling, and request/response processing
 * for VocaFuse API integration.
 */

import { VocaFuseError, NetworkError, createErrorFromResponse, wrapUnknownError } from './errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  signal?: AbortSignal;
}

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

export interface ClientConfig {
  baseUrl?: string;
  timeout?: number;
  retries?: RetryOptions;
  defaultHeaders?: Record<string, string>;
}

/**
 * VocaFuse API Response envelope structure
 */
export interface ApiResponse<T = unknown> {
  object: string;
  code?: string;
  message?: string;
  data: T;
  meta?: Record<string, unknown>;
  request_id: string;
}

/**
 * HTTP Client with retry logic and error handling
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly retryOptions: RetryOptions;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: ClientConfig = {}) {
    this.baseUrl = config.baseUrl || '';
    this.timeout = config.timeout || 30000; // 30 seconds default
    this.retryOptions = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2,
      ...config.retries
    };
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...config.defaultHeaders
    };
  }

  /**
   * Make an HTTP request with retry logic
   */
  async request<T = unknown>(
    url: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const fullUrl = this.buildUrl(url);
    const requestOptions = this.buildRequestOptions(options);
    
    let lastError: Error | undefined;
    const maxAttempts = (options.retries ?? this.retryOptions.maxRetries) + 1;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.executeRequest(fullUrl, requestOptions);
        return await this.processResponse<T>(response);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't retry on the last attempt or for non-retryable errors
        if (attempt === maxAttempts || !this.shouldRetry(lastError, attempt)) {
          break;
        }
        
        // Wait before retrying
        const delay = this.calculateRetryDelay(attempt);
        await this.sleep(delay);
      }
    }
    
    // All retries exhausted, throw the last error
    throw wrapUnknownError(lastError, {
      url: fullUrl,
      method: options.method || 'GET',
      attempts: maxAttempts
    });
  }

  /**
   * GET request
   */
  async get<T = unknown>(url: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(url, { ...options, method: 'GET' });
  }

  /**
   * POST request
   */
  async post<T = unknown>(url: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(url, { ...options, method: 'POST', body });
  }

  /**
   * PUT request
   */
  async put<T = unknown>(url: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(url, { ...options, method: 'PUT', body });
  }

  /**
   * DELETE request
   */
  async delete<T = unknown>(url: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(url, { ...options, method: 'DELETE' });
  }

  private buildUrl(url: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    const base = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const path = url.startsWith('/') ? url : `/${url}`;
    return `${base}${path}`;
  }

  private buildRequestOptions(options: RequestOptions): RequestInit {
    const headers = {
      ...this.defaultHeaders,
      ...options.headers
    };

    // Do not auto-add X-Request-Id in browser to avoid CORS issues; allow callers to provide it explicitly if desired

    let body: string | FormData | undefined;
    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        body = options.body;
        // Remove content-type header for FormData (let browser set it)
        delete (headers as Record<string, string>)['Content-Type'];
      } else {
        body = JSON.stringify(options.body);
      }
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || this.timeout);

    // Combine signals if provided
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    return {
      method: options.method || 'GET',
      headers,
      body,
      signal: controller.signal,
      // Clear timeout when request completes
      ...({ timeoutId } as Record<string, unknown>) // Store for cleanup
    } as RequestInit & { timeoutId?: number };
  }

  private async executeRequest(url: string, options: RequestInit & { timeoutId?: number }): Promise<Response> {
    try {
      const response = await fetch(url, options);
      
      // Clear timeout
      if (options.timeoutId) {
        clearTimeout(options.timeoutId);
      }
      
      return response;
    } catch (error) {
      // Clear timeout on error
      if (options.timeoutId) {
        clearTimeout(options.timeoutId);
      }
      
      // Handle fetch errors
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new NetworkError('Request timeout', error, false, { url });
        }
        throw new NetworkError('Network request failed', error, true, { url });
      }
      
      throw error as Error;
    }
  }

  private async processResponse<T>(response: Response): Promise<ApiResponse<T>> {
    let responseBody: unknown;
    
    try {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }
    } catch (error) {
      throw new NetworkError('Failed to parse response', error instanceof Error ? error : undefined, false, {
        status: response.status,
        statusText: response.statusText
      });
    }

    if (!response.ok) {
      throw createErrorFromResponse(response, responseBody);
    }

    // Validate response structure for VocaFuse API
    if (typeof responseBody === 'object' && responseBody !== null && 'data' in (responseBody as Record<string, unknown>)) {
      return responseBody as ApiResponse<T>;
    }

    // Handle non-standard responses
    return {
      object: 'response',
      data: responseBody as T,
      request_id: response.headers.get('X-Request-Id') || 'unknown'
    };
  }

  private shouldRetry(error: Error, attempt: number): boolean {
    // Don't retry if we've exceeded max retries
    if (attempt >= this.retryOptions.maxRetries) {
      return false;
    }

    // Don't retry VocaFuse errors that are marked as non-retryable
    if (error instanceof VocaFuseError && !error.retryable) {
      return false;
    }

    // Retry network errors
    if (error instanceof NetworkError && error.retryable) {
      return true;
    }

    // Retry on timeout
    if (error.name === 'AbortError') {
      return true;
    }

    return false;
  }

  private calculateRetryDelay(attempt: number): number {
    const delay = this.retryOptions.baseDelay * Math.pow(this.retryOptions.backoffFactor, attempt - 1);
    const jitter = Math.random() * 0.1 * delay; // Add 10% jitter
    return Math.min(delay + jitter, this.retryOptions.maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}


