import axios from "axios";
import * as cheerio from "cheerio";
import { URL } from "url";
import { ScrapedPage } from "../types";
import logger from "../utils/logger";
import { pineconeService } from "./pineconeService";

interface CrawlOptions {
     maxDepth?: number;
     maxPages?: number;
     respectRobotsTxt?: boolean;
}

class ScraperService {
     private visitedUrls: Set<string> = new Set();
     private urlQueue: Array<{ url: string; depth: number }> = [];
     private scrapedPages: ScrapedPage[] = [];
     private baseUrl: string = "";
     private maxDepth: number = 3;
     private maxPages: number = 100;
     private currentUserId: string = "";

     normalizeUrl(url: string): string {
          try {
               const urlObj = new URL(url);
               urlObj.hash = "";
               return urlObj.href.replace(/\/$/, "");
          } catch (error) {
               return url;
          }
     }

     isValidUrl(url: string, baseUrl: string): boolean {
          try {
               const urlObj = new URL(url);
               const baseUrlObj = new URL(baseUrl);

               // Normalize hostnames by removing 'www.' prefix for comparison
               const normalizeHostname = (hostname: string) => hostname.replace(/^www\./, '');
               const urlHostname = normalizeHostname(urlObj.hostname);
               const baseHostname = normalizeHostname(baseUrlObj.hostname);

               // Check if the URL is from the same domain
               if (urlHostname !== baseHostname) {
                    return false;
               }

               // Exclude certain file types
               const excludeExtensions = [
                    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp",
                    ".zip", ".rar", ".exe", ".dmg",
                    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
                    ".mp4", ".mp3", ".avi", ".mov", ".wav",
                    ".css", ".js", ".json", ".xml"
               ];
               if (excludeExtensions.some((ext) => urlObj.pathname.toLowerCase().endsWith(ext))) {
                    return false;
               }

               // Exclude mailto, tel, and other non-http protocols
               if (!urlObj.protocol.startsWith("http")) {
                    return false;
               }

               return true;
          } catch (error) {
               return false;
          }
     }

     async fetchPageContent(url: string): Promise<string> {
          try {
               const response = await axios.get(url, {
                    headers: {
                         "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                    },
                    timeout: 10000,
               });
               return response.data;
          } catch (error) {
               logger.error(`Error fetching page content from ${url}`, { error });
               throw error;
          }
     }

     extractPageData(html: string, url: string): ScrapedPage {
          const $ = cheerio.load(html);

          $("script").remove();
          $("style").remove();
          $("noscript").remove();
          $("iframe").remove();

          const title = $("title").text().trim() || $("h1").first().text().trim() || "No Title";

          const content = $("body").text().replace(/\s+/g, " ").trim();

          const links: string[] = [];
          $("a[href]").each((_, element) => {
               const href = $(element).attr("href");
               if (href && href.trim()) {
                    // Skip anchor links, javascript links, etc.
                    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
                         return;
                    }

                    try {
                         const absoluteUrl = new URL(href, url).href;
                         links.push(absoluteUrl);
                    } catch (error) {
                         // Invalid URL, skip it
                         logger.warn(`Invalid URL found: ${href}`, { error });
                    }
               }
          });

          // Remove duplicates
          const uniqueLinks = [...new Set(links)];

          const metadata: any = {};

          const description = $('meta[name="description"]').attr("content");
          if (description) metadata.description = description;

          const keywords = $('meta[name="keywords"]').attr("content");
          if (keywords) metadata.keywords = keywords;

          const author = $('meta[name="author"]').attr("content");
          if (author) metadata.author = author;

          const ogTitle = $('meta[property="og:title"]').attr("content");
          if (ogTitle) metadata.ogTitle = ogTitle;

          const ogDescription = $('meta[property="og:description"]').attr("content");
          if (ogDescription) metadata.ogDescription = ogDescription;

          return {
               url,
               title,
               content,
               links: uniqueLinks,
               metadata,
          };
     }

     async crawlPage(url: string, depth: number): Promise<void> {
          const normalizedUrl = this.normalizeUrl(url);

          if (this.visitedUrls.has(normalizedUrl)) {
               return;
          }

          if (depth > this.maxDepth || this.visitedUrls.size >= this.maxPages) {
               return;
          }

          this.visitedUrls.add(normalizedUrl);
          logger.info(`Crawling (depth ${depth}): ${normalizedUrl}`);

          try {
               const html = await this.fetchPageContent(normalizedUrl);
               const pageData = this.extractPageData(html, normalizedUrl);
               this.scrapedPages.push(pageData);

               await pineconeService.upsertDocument(this.currentUserId, pageData.url, pageData.title, pageData.content, pageData.metadata);

               if (depth < this.maxDepth) {
                    let validLinksCount = 0;
                    let alreadyVisitedCount = 0;
                    let invalidLinksCount = 0;

                    for (const link of pageData.links) {
                         const normalizedLink = this.normalizeUrl(link);

                         if (this.visitedUrls.has(normalizedLink)) {
                              alreadyVisitedCount++;
                              continue;
                         }

                         if (this.isValidUrl(normalizedLink, this.baseUrl)) {
                              this.urlQueue.push({ url: normalizedLink, depth: depth + 1 });
                              validLinksCount++;
                         } else {
                              invalidLinksCount++;
                         }
                    }

                    logger.info(`Links found on ${normalizedUrl}: ${pageData.links.length} total, ${validLinksCount} valid and queued, ${alreadyVisitedCount} already visited, ${invalidLinksCount} invalid/external`);
               }
          } catch (error) {
               logger.error(`Error crawling page: ${normalizedUrl}`, { error });
          }
     }

     async scrapeWebsite(
          userId: string,
          url: string,
          options: CrawlOptions = {}
     ): Promise<{
          success: boolean;
          totalPages: number;
          pages: ScrapedPage[];
          message: string;
     }> {
          try {
               this.visitedUrls.clear();
               this.urlQueue = [];
               this.scrapedPages = [];
               this.baseUrl = url;
               this.maxDepth = options.maxDepth || 3;
               this.maxPages = options.maxPages || 100;
               this.currentUserId = userId;

               await pineconeService.ensureIndexExists();

               this.urlQueue.push({ url, depth: 0 });

               while (this.urlQueue.length > 0 && this.visitedUrls.size < this.maxPages) {
                    const { url: currentUrl, depth } = this.urlQueue.shift()!;
                    await this.crawlPage(currentUrl, depth);
               }

               logger.info(`Scraping completed for user ${userId}. Total pages scraped: ${this.scrapedPages.length}`);

               return {
                    success: true,
                    totalPages: this.scrapedPages.length,
                    pages: this.scrapedPages,
                    message: `Successfully scraped and stored ${this.scrapedPages.length} pages`,
               };
          } catch (error) {
               logger.error("Error in scrapeWebsite", { error, userId });
               return {
                    success: false,
                    totalPages: 0,
                    pages: [],
                    message: `Error scraping website: ${error instanceof Error ? error.message : "Unknown error"}`,
               };
          }
     }

     async getScrapingProgress(): Promise<{
          visitedPages: number;
          queuedPages: number;
          totalPages: number;
     }> {
          return {
               visitedPages: this.visitedUrls.size,
               queuedPages: this.urlQueue.length,
               totalPages: this.scrapedPages.length,
          };
     }
}

export const scraperService = new ScraperService();
