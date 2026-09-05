const axios = require("axios");
const cheerio = require("cheerio");

/**
 * Scrape company data from a website
 * @param {string} url - The website URL to scrape
 * @returns {Promise<Object>} Scraped data: companyName, email, phone, location, productDetails
 */
const scrapeCompanyData = async (url) => {
    try {
        console.log(`[WebScrapingService] Starting scrape for: ${url}`);

        // Fetch the website with a User-Agent header
        try {
            var { data } = await axios.get(url, {
                timeout: 15000,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                },
                maxRedirects: 5,
                validateStatus: function (status) {
                    return status < 500; // Don't throw on 4xx responses, only 5xx
                },
            });
        } catch (fetchError) {
            if (fetchError.code === "ECONNREFUSED") {
                throw new Error(
                    `Cannot connect to ${url}. Check if the URL is correct and the website is online.`,
                );
            } else if (
                fetchError.code === "ETIMEDOUT" ||
                fetchError.code === "ENOTFOUND"
            ) {
                throw new Error(
                    `Cannot reach ${url}. Check your internet connection or the URL.`,
                );
            } else if (fetchError.message.includes("getaddrinfo")) {
                throw new Error(
                    `Invalid website URL or domain not found: ${url}`,
                );
            } else {
                throw new Error(
                    `Failed to fetch website: ${fetchError.message}`,
                );
            }
        }

        if (!data) {
            throw new Error("No content found on website");
        }

        console.log(
            `[WebScrapingService] Successfully fetched, parsing HTML...`,
        );

        // Load HTML into cheerio
        const $ = cheerio.load(data);

        // Helper function to extract phone numbers
        const extractPhone = () => {
            // Check for tel: links
            const telLink = $('a[href^="tel:"]').first().attr("href");
            if (telLink) {
                return telLink.replace("tel:", "").trim();
            }

            // Try data-phone attribute
            const dataPhone = $("[data-phone]").first().attr("data-phone");
            if (dataPhone) return dataPhone.trim();

            // Try phone class
            const phoneText = $('.phone, .telephone, .tel, [class*="phone"]')
                .first()
                .text()
                .trim();
            if (phoneText) return phoneText;

            return "";
        };

        // Helper function to extract email
        const extractEmail = () => {
            // Check for mailto: links
            const mailLink = $('a[href^="mailto:"]').first().attr("href");
            if (mailLink) {
                return mailLink.replace("mailto:", "").trim();
            }

            // Try data-email attribute
            const dataEmail = $("[data-email]").first().attr("data-email");
            if (dataEmail) return dataEmail.trim();

            // Try email class or span
            const emailText = $('.email, [class*="email"]')
                .first()
                .text()
                .trim();
            if (emailText && emailText.includes("@")) return emailText;

            return "";
        };

        // Helper function to extract company name
        const extractCompanyName = () => {
            // Try h1 with company class
            let name = $('h1.company, h1[class*="company"]')
                .first()
                .text()
                .trim();
            if (name) return name;

            // Try data-company attribute
            name = $("[data-company]").first().attr("data-company");
            if (name) return name.trim();

            // Try first h1
            name = $("h1").first().text().trim();
            if (name && name.length < 100) return name;

            // Try title tag or main title
            name = $("title").first().text().trim();
            if (name) {
                // Extract just the company name from title
                const parts = name.split("|")[0].trim();
                if (parts.length < 100) return parts;
            }

            return "";
        };

        // Helper function to extract location
        const extractLocation = () => {
            // Check for address-related elements
            let location = $("[data-location], .location, .address, .city")
                .first()
                .text()
                .trim();
            if (location) return location;

            // Try finding in common footer areas
            location = $("footer .address, footer .location")
                .first()
                .text()
                .trim();
            if (location) return location;

            return "";
        };

        // Helper function to extract product details
        const extractProductDetails = () => {
            // Try dedicated sections
            let products = $(
                '.products, .services, .offerings, [class*="product"], [class*="service"], .portfolio',
            )
                .first()
                .text()
                .trim();

            if (products) {
                // Clean up and limit length
                return products
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0)
                    .slice(0, 5)
                    .join(", ")
                    .substring(0, 300);
            }

            // Try meta description
            const metaDesc = $('meta[name="description"]').attr("content");
            if (metaDesc) return metaDesc.substring(0, 300);

            return "";
        };

        // Extract all data
        const scrapedData = {
            companyName: extractCompanyName(),
            email: extractEmail(),
            phone: extractPhone(),
            location: extractLocation(),
            productDetails: extractProductDetails(),
            website: url,
        };

        console.log(`[WebScrapingService] Extraction complete:`, scrapedData);
        return scrapedData;
    } catch (error) {
        console.error("[WebScrapingService] Error scraping:", {
            message: error.message,
            code: error.code,
            url: url,
        });
        throw error;
    }
};

module.exports = {
    scrapeCompanyData,
};
