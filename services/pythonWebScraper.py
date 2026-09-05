#!/usr/bin/env python3
"""
Advanced Web Scraping Service
Extracts comprehensive business data from websites including:
- Company details (name, email, phone, location, products)
- Social media links
- Contact information
- Website metadata and tech stack
"""

import requests
from bs4 import BeautifulSoup
import re
import json
import sys
from urllib.parse import urljoin, urlparse
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Common email patterns
EMAIL_REGEX = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'

# Common phone patterns (flexible)
PHONE_REGEX = r'(?:\+?\d{1,3}[-.\s]?)?\(?(?:\d{3})?\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'

# Social media patterns
SOCIAL_PATTERNS = {
    'linkedin': r'(?:https?://)?(?:www\.)?linkedin\.com/(?:company|in)/[\w-]+',
    'facebook': r'(?:https?://)?(?:www\.)?facebook\.com/[\w.-]+',
    'twitter': r'(?:https?://)?(?:www\.)?twitter\.com/[\w]+',
    'instagram': r'(?:https?://)?(?:www\.)?instagram\.com/[\w.]+',
    'youtube': r'(?:https?://)?(?:www\.)?youtube\.com/(?:c|channel|user)/[\w-]+',
}


class WebScraper:
    def __init__(self, url, timeout=10):  # Reduced from 15 to 10 seconds
        self.url = url
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        self.soup = None
        self.text_content = ""
        self.html = ""

    @staticmethod
    def clean_text(text):
        """Clean and normalize extracted text"""
        if not text:
            return None
        
        # Remove extra whitespace and newlines
        text = re.sub(r'\s+', ' ', text).strip()
        
        # Remove leading/trailing punctuation
        text = text.strip('.,;:!?\'"')
        
        # Limit length
        if len(text) > 500:
            text = text[:497] + '...'
        
        return text if len(text) > 3 else None

    def fetch_page(self):
        """Fetch the webpage"""
        try:
            logger.info(f"Fetching URL: {self.url}")
            response = self.session.get(
                self.url,
                timeout=self.timeout,
                allow_redirects=True,
                verify=True
            )
            response.raise_for_status()
            
            self.html = response.text
            self.soup = BeautifulSoup(self.html, 'html.parser')
            self.text_content = self.soup.get_text(separator=' ', strip=True)
            
            logger.info(f"Successfully fetched page, size: {len(self.html)} bytes")
            return True
        except requests.exceptions.Timeout:
            logger.error("Request timeout")
            return False
        except requests.exceptions.ConnectionError:
            logger.error("Connection error")
            return False
        except Exception as e:
            logger.error(f"Error fetching page: {str(e)}")
            return False

    def extract_company_name(self):
        """Extract company name from various sources"""
        logger.info("Extracting company name...")
        
        # Try <title> tag
        title = self.soup.find('title')
        if title:
            title_text = title.get_text(strip=True)
            # Remove common suffixes
            name = re.sub(r'\s*[-|–|–]\s*(Home|Official|Website)?', '', title_text)
            cleaned = self.clean_text(name)
            if cleaned and len(cleaned) > 2 and len(cleaned) < 100:
                return cleaned
        
        # Try h1 tag
        h1 = self.soup.find('h1')
        if h1:
            h1_text = h1.get_text(strip=True)
            cleaned = self.clean_text(h1_text)
            if cleaned and len(cleaned) > 2 and len(cleaned) < 100:
                return cleaned
        
        # Try meta property og:site_name
        og_site = self.soup.find('meta', property='og:site_name')
        if og_site and og_site.get('content'):
            cleaned = self.clean_text(og_site.get('content'))
            if cleaned:
                return cleaned
        
        # Try organization schema
        schemas = self.soup.find_all('script', {'type': 'application/ld+json'})
        for schema in schemas:
            try:
                data = json.loads(schema.string)
                if isinstance(data, dict) and data.get('name'):
                    cleaned = self.clean_text(data.get('name'))
                    if cleaned:
                        return cleaned
            except:
                pass
        
        return None

    def extract_emails(self):
        """Extract email addresses"""
        logger.info("Extracting emails...")
        emails = set()
        
        # Search in full text
        found_emails = re.findall(EMAIL_REGEX, self.text_content)
        emails.update(found_emails)
        
        # Search in mailto links
        mailto_links = self.soup.find_all('a', href=re.compile(r'^mailto:'))
        for link in mailto_links:
            email = link.get('href', '').replace('mailto:', '').split('?')[0]
            if email:
                emails.add(email)
        
        # Filter out common non-business emails
        business_emails = [e for e in emails if not any(
            domain in e.lower() for domain in ['test', 'example', 'spam']
        )]
        
        logger.info(f"Found {len(business_emails)} emails")
        return list(business_emails)[:5]  # Return top 5

    def extract_phones(self):
        """Extract phone numbers"""
        logger.info("Extracting phone numbers...")
        phones = set()
        
        # Search in text
        found_phones = re.findall(PHONE_REGEX, self.text_content)
        phones.update(found_phones)
        
        # Search in tel links
        tel_links = self.soup.find_all('a', href=re.compile(r'^tel:'))
        for link in tel_links:
            phone = link.get('href', '').replace('tel:', '')
            if phone:
                phones.add(phone)
        
        logger.info(f"Found {len(phones)} phone numbers")
        return list(phones)[:5]  # Return top 5

    def extract_social_media(self):
        """Extract social media links"""
        logger.info("Extracting social media links...")
        social_links = {}
        
        # Find all links
        for link in self.soup.find_all('a', href=True):
            href = link.get('href', '').lower()
            
            for platform, pattern in SOCIAL_PATTERNS.items():
                if re.search(pattern, href):
                    if platform not in social_links:
                        social_links[platform] = href
        
        logger.info(f"Found social media on {len(social_links)} platforms")
        return social_links

    def extract_location(self):
        """Extract location with optimized speed and accuracy"""
        logger.info("Extracting location...")
        
        best_address = None
        
        # FASTEST: Schema.org (99% accurate, most websites have it)
        schemas = self.soup.find_all('script', {'type': 'application/ld+json'})
        for schema in schemas:
            try:
                data = json.loads(schema.string)
                if isinstance(data, dict):
                    # Check for complete address in schema
                    if data.get('address'):
                        addr = data.get('address')
                        if isinstance(addr, dict):
                            parts = []
                            if addr.get('streetAddress'):
                                parts.append(addr.get('streetAddress'))
                            if addr.get('addressLocality'):
                                parts.append(addr.get('addressLocality'))
                            if addr.get('addressRegion'):
                                parts.append(addr.get('addressRegion'))
                            if addr.get('postalCode'):
                                parts.append(addr.get('postalCode'))
                            if parts:
                                text = ', '.join(parts)
                                cleaned = self.clean_text(text)
                                if cleaned and len(cleaned) > 15:
                                    return cleaned  # Early exit - found good address
                        elif isinstance(addr, str) and len(addr) > 15:
                            cleaned = self.clean_text(addr)
                            if cleaned:
                                return cleaned  # Early exit
            except:
                pass
        
        # SECOND: Direct <address> tag
        address_tag = self.soup.find('address')
        if address_tag:
            text = address_tag.get_text(strip=True)
            # Filter out phone numbers
            text = re.sub(r'[\+]?[\d\s\-\(\)]{10,}', '', text).strip()
            cleaned = self.clean_text(text)
            if cleaned and len(cleaned) > 10 and self._is_valid_address(cleaned):
                return cleaned
        
        # THIRD: Footer section (common location)
        footer = self.soup.find('footer')
        if footer:
            # Look specifically for address patterns in footer
            text = footer.get_text(strip=True)
            # Extract first 3 lines (usually has address)
            lines = text.split('\n')
            for line in lines[:5]:
                line = line.strip()
                if self._is_valid_address(line) and len(line) > 15:
                    text = re.sub(r'[\+]?[\d\s\-\(\)]{10,}', '', line).strip()
                    cleaned = self.clean_text(text)
                    if cleaned:
                        return cleaned
        
        # FOURTH: Contact/address sections
        contact_div = self.soup.find(['div', 'section'], 
                                    {'class': re.compile(r'contact|address|location', re.IGNORECASE)})
        if contact_div:
            text = contact_div.get_text(strip=True)
            lines = text.split('\n')
            for line in lines[:5]:
                line = line.strip()
                if self._is_valid_address(line) and len(line) > 15:
                    text = re.sub(r'[\+]?[\d\s\-\(\)]{10,}', '', line).strip()
                    cleaned = self.clean_text(text)
                    if cleaned:
                        return cleaned
        
        # LAST RESORT ONLY: Look for physical address patterns
        # Only match VERY specific patterns to avoid junk
        address_patterns = [
            r'\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|Road|Lane|Avenue|Boulevard),\s+[A-Z][a-z]+,\s+[A-Z]{2}\s+\d{5}',
            r'[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s+[A-Z]{2}\s+\d{5}(?:[-\d]*)?',  # City, State ZIP
        ]
        
        for pattern in address_patterns:
            match = re.search(pattern, self.text_content)
            if match:
                text = match.group(0)
                if self._is_valid_address(text):
                    cleaned = self.clean_text(text)
                    if cleaned:
                        return cleaned
        
        return None
    
    def _is_valid_address(self, text):
        """Check if text is a REAL address - strict validation"""
        if not text or len(text) < 10:
            return False
        
        # DISQUALIFIERS - reject immediately
        disqualifiers = [
            'software', 'product', 'service', 'solution', 'platform',
            'since we decided', 'given by', 'provided by', 'made by',
            'appointment', 'meeting', 'schedule', 'January', 'February',
            'click here', 'read more', 'learn more', 'visit us',
        ]
        
        lower = text.lower()
        if any(word in lower for word in disqualifiers):
            return False
        
        # QUALIFIERS - must have at least one
        qualifiers = [
            r'\d{1,5}\s+[A-Za-z]',  # Street number (e.g., "123 Main")
            r',\s*[A-Z]{2}\s+\d{5}',  # State, ZIP
            r'(?:street|road|lane|avenue|boulevard)',  # Street type
            r'(?:building|suite|floor|office)',  # Building type
        ]
        
        has_qualifier = any(re.search(q, text, re.IGNORECASE) for q in qualifiers)
        return has_qualifier

    def extract_products_and_services(self):
        """Extract product and service information with high accuracy"""
        logger.info("Extracting products/services...")
        
        products = []
        
        # 1. MOST RELIABLE: Schema.org markup
        schemas = self.soup.find_all('script', {'type': 'application/ld+json'})
        for schema in schemas:
            try:
                data = json.loads(schema.string)
                if isinstance(data, dict):
                    # Get main description (most reliable source)
                    if data.get('description') and len(data.get('description', '')) > 30:
                        desc = data.get('description')
                        cleaned = self.clean_text(desc)
                        if cleaned and len(cleaned) > 30:
                            products.append(cleaned)
                            logger.info(f"Found from schema description: {cleaned[:50]}...")
                    
                    # Get offers/products from schema
                    if isinstance(data.get('offers'), list):
                        for offer in data.get('offers', [])[:5]:
                            if isinstance(offer, dict):
                                if offer.get('name'):
                                    cleaned = self.clean_text(offer.get('name'))
                                    if cleaned and len(cleaned) > 5:
                                        products.append(cleaned)
                                        logger.info(f"Found offer: {cleaned}")
            except:
                pass
        
        # 2. Look for "Services" section in headings
        services_heading = None
        for heading in self.soup.find_all(['h2', 'h3', 'h4']):
            heading_text = heading.get_text(strip=True).lower()
            if any(word in heading_text for word in ['service', 'product', 'solution', 'offering', 'feature']):
                services_heading = heading
                logger.info(f"Found services section: {heading_text}")
                break
        
        if services_heading:
            # Get content after the heading
            parent = services_heading.find_parent(['section', 'div', 'article'])
            if parent:
                # Extract bullet points and list items
                for item in parent.find_all(['li', 'p', 'div']):
                    text = item.get_text(strip=True)
                    # Filter out nav items and short text
                    if (len(text) > 8 and len(text) < 300 and 
                        not self._is_nav_or_junk(text)):
                        cleaned = self.clean_text(text)
                        if cleaned and len(cleaned) > 8:
                            products.append(cleaned)
                            logger.info(f"Found from services section: {cleaned[:50]}...")
        
        # 3. Look for common service keywords in paragraphs
        if not products:
            product_keywords = [
                'service', 'solution', 'product', 'offer', 'provide', 'develop',
                'create', 'build', 'design', 'deliver', 'support'
            ]
            
            for p in self.soup.find_all('p'):
                text = p.get_text(strip=True)
                # Check if paragraph mentions services/products
                if (any(kw in text.lower() for kw in product_keywords) and
                    len(text) > 20 and len(text) < 300 and
                    not self._is_nav_or_junk(text)):
                    cleaned = self.clean_text(text)
                    if cleaned and len(cleaned) > 20:
                        products.append(cleaned)
                        logger.info(f"Found from paragraph: {cleaned[:50]}...")
        
        # 4. Extract from company description (meta description)
        description_meta = self.soup.find('meta', attrs={'name': 'description'})
        if description_meta:
            desc = description_meta.get('content', '')
            if desc and len(desc) > 30:
                cleaned = self.clean_text(desc)
                if cleaned and len(cleaned) > 30:
                    products.append(cleaned)
                    logger.info(f"Found from meta description: {cleaned[:50]}...")
        
        # 5. Look in "Why Choose Us" or "About Us" sections
        for section_type in ['why-choose', 'about-us', 'about']:
            about = self.soup.find(['div', 'section'], 
                                  {'class': re.compile(section_type, re.IGNORECASE)})
            if about:
                # Get first meaningful paragraph
                for p in about.find_all('p')[:3]:
                    text = p.get_text(strip=True)
                    if len(text) > 30 and not self._is_nav_or_junk(text):
                        cleaned = self.clean_text(text)
                        if cleaned and len(cleaned) > 30:
                            products.append(cleaned)
                            logger.info(f"Found from about section: {cleaned[:50]}...")
        
        # Remove duplicates while preserving order
        seen = set()
        unique_products = []
        for p in products:
            # Skip if we've seen similar content (using first 50 chars)
            snippet = p[:50].lower()
            if snippet not in seen and len(p) > 8:
                unique_products.append(p)
                seen.add(snippet)
        
        logger.info(f"Final products/services count: {len(unique_products)}")
        return unique_products[:8]  # Return top 8
    
    def _is_nav_or_junk(self, text):
        """Check if text is navigation or junk content"""
        lower = text.lower()
        
        junk_patterns = [
            'click here', 'read more', 'learn more', 'view more',
            'home', 'about', 'contact', 'menu', 'link', 'follow',
            'subscribe', 'download', 'visit', 'go to', 'made by',
            'copyright', 'all rights', 'privacy policy', 'terms',
            'call us', 'contact us', 'get in touch', 'appointment'
        ]
        
        return any(pattern in lower for pattern in junk_patterns)

    def extract_metadata(self):
        """Extract website metadata"""
        logger.info("Extracting metadata...")
        metadata = {}
        
        # Description
        description = self.soup.find('meta', attrs={'name': 'description'})
        if description:
            metadata['description'] = description.get('content')
        
        # Keywords
        keywords = self.soup.find('meta', attrs={'name': 'keywords'})
        if keywords:
            metadata['keywords'] = keywords.get('content')
        
        # Language
        html_tag = self.soup.find('html')
        if html_tag:
            metadata['language'] = html_tag.get('lang', 'unknown')
        
        # Detect tech stack by common patterns
        tech_stack = []
        html_lower = self.html.lower()
        
        # Simple detection of common frameworks/tech
        tech_indicators = {
            'React': ['react.js', '/static/js/', 'react-id'],
            'Vue.js': ['vue.js', '__vue__'],
            'Angular': ['angular.js', 'ng-app'],
            'WordPress': ['wp-content', 'wp-includes'],
            'Bootstrap': ['bootstrap.css', 'bootstrap.min.css'],
            'jQuery': ['jquery.js', 'jquery.min.js'],
        }
        
        for tech, indicators in tech_indicators.items():
            if any(ind in html_lower for ind in indicators):
                tech_stack.append(tech)
        
        if tech_stack:
            metadata['tech_stack'] = tech_stack
        
        return metadata

    def extract_contact_page(self):
        """Extract contact information by finding contact page"""
        logger.info("Extracting contact page info...")
        
        contact_info = {}
        
        # Look for common contact sections
        contact_sections = self.soup.find_all(
            ['div', 'section'],
            {'class': re.compile(r'contact', re.IGNORECASE)}
        )
        
        for section in contact_sections:
            text = section.get_text(strip=True)
            
            # Extract emails from contact section
            emails = re.findall(EMAIL_REGEX, text)
            if emails:
                contact_info['contact_emails'] = emails[:3]
            
            # Extract phones from contact section
            phones = re.findall(PHONE_REGEX, text)
            if phones:
                contact_info['contact_phones'] = phones[:3]
        
        return contact_info

    def scrape(self):
        """Run complete scraping and return all extracted data"""
        logger.info("Starting web scraping...")
        
        if not self.fetch_page():
            return {
                'success': False,
                'error': 'Failed to fetch webpage'
            }
        
        try:
            result = {
                'success': True,
                'url': self.url,
                'companyName': self.extract_company_name(),
                'emails': self.extract_emails(),
                'phones': self.extract_phones(),
                'location': self.extract_location(),
                'productDetails': self.extract_products_and_services(),
                'socialMedia': self.extract_social_media(),
                'metadata': self.extract_metadata(),
                'contactInfo': self.extract_contact_page(),
            }
            
            logger.info("Scraping completed successfully")
            return result
        except Exception as e:
            logger.error(f"Error during scraping: {str(e)}")
            return {
                'success': False,
                'error': str(e)
            }


def main():
    """Main entry point for CLI usage"""
    if len(sys.argv) < 2:
        print('Usage: python pythonWebScraper.py "<url>"')
        sys.exit(1)
    
    url = sys.argv[1]
    
    try:
        scraper = WebScraper(url)
        result = scraper.scrape()
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()
