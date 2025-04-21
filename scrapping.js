import chromium from 'chrome-aws-lambda';
import puppeteer from 'puppeteer-core';
import fs from 'fs';

// Main function to scrape and analyze any website, focusing on head tag content
export async function analyzeWebsite(url) {
  let browser = null;
  
  try {
    // Normalize URL format
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    console.log(`Starting head tag analysis of ${url}`);
    
    // Launch browser using chrome-aws-lambda
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: true,
      ignoreHTTPSErrors: true,
    });
    
    const page = await browser.newPage();
    
    // Set a reasonable timeout
    await page.setDefaultNavigationTimeout(30000);
    
    // Navigate to the URL
    console.log(`Navigating to ${url}`);
    const response = await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Check if the page loaded successfully
    if (!response || response.status() !== 200) {
      throw new Error(`Failed to load the page: ${response ? response.status() : 'No response'}`);
    }
    
    // Extract all content from the head tag
    const headContent = await page.evaluate(() => {
      // Get the full HTML of the head tag
      const headHTML = document.head.outerHTML;
      
      // Get all meta tags
      const metaTags = Array.from(document.head.querySelectorAll('meta')).map(meta => {
        const attributes = {};
        Array.from(meta.attributes).forEach(attr => {
          attributes[attr.name] = attr.value;
        });
        return attributes;
      });
      
      // Get the title
      const title = document.title;
      
      // Get all link tags (for stylesheets, favicons, etc.)
      const linkTags = Array.from(document.head.querySelectorAll('link')).map(link => {
        const attributes = {};
        Array.from(link.attributes).forEach(attr => {
          attributes[attr.name] = attr.value;
        });
        return attributes;
      });
      
      // Get all script tags in head
      const scriptTags = Array.from(document.head.querySelectorAll('script')).map(script => {
        return {
          type: script.type,
          src: script.src,
          async: script.async,
          defer: script.defer
        };
      });
      
      return {
        title,
        headHTML,
        metaTags,
        linkTags,
        scriptTags
      };
    });
    
    // Extract specific metadata that's commonly used
    const metaData = {
      description: null,
      keywords: null,
      viewport: null,
      robots: null,
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
      twitterCard: null,
      twitterTitle: null,
      twitterDescription: null,
      twitterImage: null,
      canonical: null
    };
    
    // Process meta tags to extract common metadata
    headContent.metaTags.forEach(meta => {
      if (meta.name === 'description') metaData.description = meta.content;
      if (meta.name === 'keywords') metaData.keywords = meta.content;
      if (meta.name === 'viewport') metaData.viewport = meta.content;
      if (meta.name === 'robots') metaData.robots = meta.content;
      
      // Open Graph tags
      if (meta.property === 'og:title') metaData.ogTitle = meta.content;
      if (meta.property === 'og:description') metaData.ogDescription = meta.content;
      if (meta.property === 'og:image') metaData.ogImage = meta.content;
      
      // Twitter Card tags
      if (meta.name === 'twitter:card') metaData.twitterCard = meta.content;
      if (meta.name === 'twitter:title') metaData.twitterTitle = meta.content;
      if (meta.name === 'twitter:description') metaData.twitterDescription = meta.content;
      if (meta.name === 'twitter:image') metaData.twitterImage = meta.content;
    });
    
    // Extract canonical URL if present
    headContent.linkTags.forEach(link => {
      if (link.rel === 'canonical') metaData.canonical = link.href;
    });
    
    // Gather all the data
    const analysisData = {
      url,
      title: headContent.title,
      metaData,
      headStats: {
        metaTagCount: headContent.metaTags.length,
        linkTagCount: headContent.linkTags.length,
        scriptTagCount: headContent.scriptTags.length
      },
      headTags: {
        meta: headContent.metaTags,
        links: headContent.linkTags,
        scripts: headContent.scriptTags
      }
    };
    
    await browser.close();
    console.log(`Head analysis of ${url} completed successfully`);
    
    return analysisData;
  } catch (error) {
    console.error(`Error analyzing ${url}:`, error);
    return {
      url,
      error: error.message,
      success: false
    };
  }
}

// Function to run as standalone script
const runScraper = async () => {
  // Check if URL was provided as command line argument
  const targetUrl = process.argv[2] || 'https://dyzo.ai';
  
  try {
    const analysis = await analyzeWebsite(targetUrl);
    console.log('Head analysis result:', JSON.stringify(analysis, null, 2));
  } catch (error) {
    console.error('Failed to run head analysis:', error);
  }
};

// If this script is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  runScraper();
}