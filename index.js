import express from 'express';
import openai from './openaiClient.js';
import { analyzeWebsite } from './scrapping.js';
import { getMessages, addMessage, clearSession, getTaskType } from './chatSession.js';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';

const app = express();

// Configure CORS
app.use(cors({
  origin: '*', // You can restrict this to specific domains in production
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Security headers
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json());

const PORT = 3000;

// Function to extract tasks from reply text
function extractTasksFromReply(reply) {
  // Check if the reply contains task indicators
  if (!reply || typeof reply !== 'string') return null;
  
  // Look for patterns like "Task 1:" or "### Task 1:" which indicate tasks in the text
  const taskPatterns = [
    /(?:#{1,3}\s*)?Task\s*(\d+)[:\)]/gi,            // Matches "Task 1:", "### Task 1:", etc.
    /(\d+)[:.]\s*([A-Z][^.]*(?:\.|$))/g,            // Matches numbered lists "1. Do something"
    /(?:#{1,3}\s*)?(\d+)[:.]\s*([A-Z][^.]*(?:\.|$))/g // Matches "# 1. Do something"
  ];
  
  let hasTaskIndicators = false;
  for (const pattern of taskPatterns) {
    if (pattern.test(reply)) {
      hasTaskIndicators = true;
      break;
    }
  }
  
  if (!hasTaskIndicators) return null;
  
  // Try to extract tasks based on different patterns
  
  // First check if there are sections with "Task" headers
  const taskSections = reply.split(/(?:#{1,3}\s*)?Task\s*\d+[:\)]/i).slice(1);
  
  // If we found task sections, parse them
  if (taskSections.length > 0) {
    const tasks = [];
    
    // Iterate through sections and extract info
    for (let i = 0; i < taskSections.length; i++) {
      const section = taskSections[i].trim();
      
      // Extract title (first line or "**Description**:" type line)
      let title = '';
      let description = section;
      let timeEstimate = '1 hour'; // Default
      
      // Try to find title in bold text or first line
      const titleMatch = section.match(/(?:\*\*([^*]+)\*\*|([^.:\n]+))/);
      if (titleMatch) {
        title = (titleMatch[1] || titleMatch[2]).trim();
        // Remove the title from the description
        description = description.replace(titleMatch[0], '').trim();
      }
      
      // Look for time estimate patterns
      const timePatterns = [
        /Time\s*Estimate\s*:\s*([^.\n]+)/i,
        /Estimated\s*Time\s*:\s*([^.\n]+)/i,
        /Duration\s*:\s*([^.\n]+)/i,
        /Takes\s*about\s*([^.\n]+)/i
      ];
      
      for (const pattern of timePatterns) {
        const timeMatch = section.match(pattern);
        if (timeMatch) {
          timeEstimate = timeMatch[1].trim();
          // Remove time estimate from description
          description = description.replace(timeMatch[0], '').trim();
          break;
        }
      }
      
      // Clean up description
      description = description
        .replace(/\*\*/g, '') // Remove bold markers
        .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
        .trim();
      
      // If we couldn't find a good title, generate one
      if (!title || title.length > 50) {
        title = `Task ${i + 1}`;
      }
      
      tasks.push({
        title,
        description,
        timeEstimate
      });
    }
    
    return tasks.length > 0 ? tasks : null;
  }
  
  // If no task sections found, try to look for numbered lists
  const lines = reply.split('\n');
  const tasks = [];
  let currentTask = null;
  let timeEstimatePattern = /(?:time|duration|estimate)s?:?\s*(\d+\s*(?:hour|hr|minute|min|day)s?)/i;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for a new numbered task
    const taskMatch = line.match(/^(\d+)[:.]\s*(.+)$/);
    
    if (taskMatch) {
      // Save the previous task if it exists
      if (currentTask) {
        tasks.push(currentTask);
      }
      
      // Start a new task
      currentTask = {
        title: taskMatch[2].trim(),
        description: '',
        timeEstimate: '1 hour' // Default
      };
    } 
    // Look for time estimates
    else if (currentTask && timeEstimatePattern.test(line)) {
      const timeMatch = line.match(timeEstimatePattern);
      if (timeMatch) {
        currentTask.timeEstimate = timeMatch[1];
      } else {
        // Add to description
        currentTask.description += line + '\n';
      }
    }
    // Add to the current task's description
    else if (currentTask && line) {
      currentTask.description += line + '\n';
    }
  }
  
  // Add the last task if it exists
  if (currentTask) {
    tasks.push(currentTask);
  }
  
  // Clean up task descriptions
  tasks.forEach(task => {
    task.description = task.description.trim();
  });
  
  return tasks.length > 0 ? tasks : null;
}

// Function to replace Tavily's simpleSearch with web scraping
async function webSearch(query) {
  try {
    console.log(`Performing web search for: ${query}`);
    
    // Extract domain or keywords from the query
    const domainMatch = query.match(/site:([a-zA-Z0-9.-]+)/);
    const urlMatch = query.match(/(https?:\/\/[^\s]+)/);
    
    let url;
    
    // If we have a specific URL in the query, use that
    if (urlMatch) {
      url = urlMatch[1];
    } 
    // If site: directive is used, extract the domain
    else if (domainMatch) {
      url = domainMatch[1];
      // Ensure it has a proper protocol
      if (!url.startsWith('http')) {
        url = 'https://' + url;
      }
    } 
    // Otherwise, try to create a search-friendly URL from the query
    else {
      // Convert the query to a search-friendly string (rough approximation of searching)
      const searchQuery = query.replace(/\s+/g, '+');
      // Use a reliable website that contains information about the topic
      url = `https://en.wikipedia.org/wiki/${searchQuery}`;
    }
    
    // Use our analyzeWebsite function to get information
    const headData = await analyzeWebsite(url);
    
    if (headData.error) {
      return `I couldn't find specific information about "${query}". Let me help based on my general knowledge.`;
    }
    
    // Format the head tag information into a useful summary
    return `
      Information about "${query}" from ${url}:
      
      Title: ${headData.title || 'Not available'}
      
      Metadata:
      ${headData.metaData.description ? `- Description: ${headData.metaData.description}` : '- No description found'}
      ${headData.metaData.keywords ? `- Keywords: ${headData.metaData.keywords}` : ''}
      ${headData.metaData.canonical ? `- Canonical URL: ${headData.metaData.canonical}` : ''}
      
      SEO Information:
      ${headData.metaData.robots ? `- Robots Directive: ${headData.metaData.robots}` : '- No robots directive found'}
      ${headData.metaData.ogTitle ? `- OG Title: ${headData.metaData.ogTitle}` : ''}
      ${headData.metaData.ogDescription ? `- OG Description: ${headData.metaData.ogDescription}` : ''}
      
      Head Tag Statistics:
      - Meta Tags: ${headData.headStats.metaTagCount}
      - Link Tags: ${headData.headStats.linkTagCount}
      - Script Tags: ${headData.headStats.scriptTagCount}
    `;
  } catch (error) {
    console.error(`Error in web search: ${error.message}`);
    return `I encountered an error while researching "${query}". Let me provide information based on my general knowledge.`;
  }
}

// Add this function to analyze SEO issues based on head data
async function analyzeSEOIssues(url) {
  try {
    // Get the head data from the website
    const headData = await analyzeWebsite(url);
    
    if (headData.error) {
      return {
        success: false,
        issues: [`Could not analyze the website: ${headData.error}`]
      };
    }
    
    // Identify specific SEO issues
    const issues = [];
    
    // 1. Check meta description
    if (!headData.metaData.description) {
      issues.push({
        type: "missing_meta_description",
        severity: "high",
        description: "The website is missing a meta description tag, which is crucial for SEO and click-through rates in search results."
      });
    } else if (headData.metaData.description.length < 50) {
      issues.push({
        type: "short_meta_description",
        severity: "medium",
        description: "The meta description is too short (less than 50 characters). Ideal meta descriptions are between 150-160 characters."
      });
    } else if (headData.metaData.description.length > 160) {
      issues.push({
        type: "long_meta_description",
        severity: "low",
        description: "The meta description exceeds the recommended 160 characters and might get cut off in search results."
      });
    }
    
    // 2. Check title
    if (!headData.title) {
      issues.push({
        type: "missing_title",
        severity: "high",
        description: "The website is missing a title tag, which is one of the most important SEO elements."
      });
    } else if (headData.title.length < 10) {
      issues.push({
        type: "short_title",
        severity: "medium",
        description: "The page title is too short. Ideal titles are between 50-60 characters."
      });
    } else if (headData.title.length > 60) {
      issues.push({
        type: "long_title",
        severity: "low",
        description: "The page title exceeds 60 characters and might get truncated in search results."
      });
    }
    
    // 3. Check canonical URL
    if (!headData.metaData.canonical) {
      issues.push({
        type: "missing_canonical",
        severity: "medium",
        description: "No canonical URL tag found, which may lead to duplicate content issues if the same content is accessible via multiple URLs."
      });
    }
    
    // 4. Check viewport for mobile responsiveness
    if (!headData.metaData.viewport) {
      issues.push({
        type: "missing_viewport",
        severity: "high",
        description: "No viewport meta tag found, which is essential for mobile responsiveness and mobile SEO."
      });
    }
    
    // 5. Check for robots directives
    if (headData.metaData.robots && headData.metaData.robots.includes("noindex")) {
      issues.push({
        type: "noindex_directive",
        severity: "critical",
        description: "The page has a noindex directive, preventing search engines from indexing it."
      });
    }
    
    // 6. Check for Open Graph tags
    if (!headData.metaData.ogTitle && !headData.metaData.ogDescription && !headData.metaData.ogImage) {
      issues.push({
        type: "missing_og_tags",
        severity: "medium",
        description: "No Open Graph tags found, which affects how content appears when shared on social media platforms."
      });
    }
    
    // 7. Check for Twitter Card tags
    if (!headData.metaData.twitterCard && !headData.metaData.twitterTitle && 
        !headData.metaData.twitterDescription && !headData.metaData.twitterImage) {
      issues.push({
        type: "missing_twitter_tags",
        severity: "low",
        description: "No Twitter Card tags found, which affects how content appears when shared on Twitter."
      });
    }
    
    // 8. Check for excessive script tags
    if (headData.headStats.scriptTagCount > 15) {
      issues.push({
        type: "excessive_scripts",
        severity: "medium",
        description: `Found ${headData.headStats.scriptTagCount} script tags in the head, which may affect page load speed and SEO performance.`
      });
    }
    
    return {
      success: true,
      url: headData.url,
      title: headData.title,
      issues: issues,
      headData: headData // Include the full head data for reference
    };
  } catch (error) {
    console.error("Error analyzing SEO issues:", error);
    return {
      success: false,
      issues: ["Error analyzing SEO issues: " + error.message]
    };
  }
}

// Endpoint for the initial message in a chat
app.post('/chat', async (req, res) => {
  try {
    // Parse request body safely
    let message, sessionId;
    
    try {
      // Check if the body is properly formatted
      if (typeof req.body !== 'object') {
        return res.status(400).json({ 
          error: "Invalid request body format. Expected JSON object."
        });
      }
      
      // Extract message and sessionId
      message = req.body.message;
      sessionId = req.body.sessionId;
      
      // Validate message exists and is a string
      if (typeof message !== 'string' || message.trim() === '') {
        return res.status(400).json({ 
          error: "Missing or invalid message in request body. Message must be a non-empty string."
        });
      }
    } catch (parseError) {
      return res.status(400).json({ 
        error: "Error parsing request body. Please ensure you're sending valid JSON."
      });
    }
    
    // If no sessionId provided, create a new session
    const currentSessionId = sessionId || uuidv4();
    
    // Add the user message to session
    addMessage(currentSessionId, { role: "user", content: message.trim() });
    
    // Process the message with GPT
    let response = await processMessage(currentSessionId);
    
    // Ensure tasks are in the tasks array, not in the reply
    response = ensureTasksInTasksArray(response);
    
    return res.json({
      sessionId: currentSessionId,
      ...response // Spread the response which contains tasks and reply
    });
  } catch (error) {
    console.error("Error in /chat:", error);
    return res.status(500).json({ 
      error: "An error occurred processing your request. Please try again."
    });
  }
});

// Endpoint to clear chat history
app.delete('/chat/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    clearSession(sessionId);
    return res.json({ success: true });
  } catch (error) {
    console.error("Error in DELETE /chat/:sessionId:", error);
    return res.status(500).json({ error: "An error occurred clearing the session" });
  }
});

// Helper function to check if the conversation is ready for tasks
function isConversationTaskReady(userMessages) {
  if (!userMessages || userMessages.length === 0) return false;
  
  // Check if the conversation contains enough information to generate tasks
  // Indicators that a conversation is ready for tasks:
  
  // 1. URL presence - if user has already provided a URL, that's a strong indicator
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  const hasURL = userMessages.some(msg => urlPattern.test(msg.content));
  
  // 2. Explicit request for tasks/help
  const taskRequestPatterns = [
    /help me (with|to)/i,
    /need (help|assistance|tasks)/i,
    /generate (some )?(tasks|steps|plan)/i,
    /what (should|can) i do/i,
    /give me (a|some) (task|plan|step)/i,
    /how (can|should) i/i,
    /improve|optimize|enhance/i,
    /steps (to|for)/i
  ];
  
  const hasTaskRequest = userMessages.some(msg => 
    taskRequestPatterns.some(pattern => pattern.test(msg.content))
  );
  
  // 3. Message count - if there are at least 2 messages, we may have enough context
  const hasMultipleMessages = userMessages.length >= 2;
  
  // 4. Message length - if any message is very detailed (over 100 words), it may contain enough context
  const hasDetailedMessage = userMessages.some(msg => 
    msg.content.split(/\s+/).length > 100
  );
  
  // Determine if ready based on combinations of the above factors
  const isReady = 
    // Definitely ready if 3+ messages
    userMessages.length >= 3 ||
    // Ready if URL + task request
    (hasURL && hasTaskRequest) ||
    // Ready if multiple messages and either a task request or detailed message
    (hasMultipleMessages && (hasTaskRequest || hasDetailedMessage));
  
  return isReady;
}

// Helper function to process messages with GPT
async function processMessage(sessionId) {
  const allMessages = getMessages(sessionId);
  
  // Only keep the system message and the last 6 messages (3 exchanges) to keep context focused
  const systemMessage = allMessages.find(msg => msg.role === "system");
  const recentMessages = allMessages.filter(msg => msg.role !== "system").slice(-6);
  
  // Combine system message with recent messages
  const messages = systemMessage ? [systemMessage, ...recentMessages] : recentMessages;
  
  // Count how many user messages we have so far
  const userMessageCount = allMessages.filter(msg => msg.role === "user").length;
  
  // Extract any URLs mentioned in the user messages
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  const userMessages = allMessages.filter(msg => msg.role === "user");
  const mentionedUrls = [];
  
  userMessages.forEach(msg => {
    const matches = msg.content.match(urlPattern);
    if (matches) {
      mentionedUrls.push(...matches);
    }
  });
  
  const uniqueUrls = [...new Set(mentionedUrls)];
  
  // Get the task type (website or general)
  const taskType = getTaskType(sessionId);
  
  // Check if conversation is ready for task generation, otherwise focus on asking questions
  if (!isConversationTaskReady(userMessages)) {
    // For website tasks, if URLs are mentioned, do preliminary research
    let additionalInfo = "";
    if (taskType === "website" && uniqueUrls.length > 0) {
      try {
        // Use our improved website analysis
        const websiteData = await analyzeWebsite(uniqueUrls[0]);
        if (websiteData && !websiteData.error) {
          additionalInfo = `\nWebsite Analysis Results:\n- Title: ${websiteData.title || 'Not found'}\n- Description: ${websiteData.metaDescription || 'Not found'}\n- Content Summary: ${websiteData.snippet ? websiteData.snippet.substring(0, 200) + '...' : 'Not available'}\n- Performance: ${websiteData.performanceMetrics?.loadTime ? (websiteData.performanceMetrics.loadTime / 1000).toFixed(2) + 's load time' : 'Not measured'}\n- Mobile Responsive: ${websiteData.isMobileResponsive ? 'Yes' : 'No'}`;
        }
      } catch (error) {
        console.error("Error in preliminary website analysis:", error);
      }
    }
    
    // Update messages with the additional info if available
    const messagesForGPT = additionalInfo 
      ? [...messages, { role: "system", content: additionalInfo }] 
      : messages;
    
    // Send conversation to GPT to get questions
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForGPT,
    tools: [
      {
        type: "function",
        function: {
          name: "search_web",
            description: "Search the web by analyzing a website",
          parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query or website URL" }
            },
            required: ["query"]
          }
        }
      }
    ],
    tool_choice: "auto"
  });

  const responseMessage = chatCompletion.choices[0].message;

    // If GPT asked to use the tool, run it
  if (responseMessage.tool_calls?.[0]) {
    const toolCall = responseMessage.tool_calls[0];
      
      try {
        // Parse the arguments safely
        let searchQuery = "";
        try {
          const args = JSON.parse(toolCall.function.arguments);
          searchQuery = args.query || "";
        } catch (parseError) {
          console.error("Error parsing tool call arguments:", parseError);
          searchQuery = "error parsing search query";
        }
        
        // Add assistant's message with tool call to the session
        const assistantMessage = {
          role: "assistant",
          tool_calls: responseMessage.tool_calls,
          content: responseMessage.content || ""
        };
        
        addMessage(sessionId, assistantMessage);
        
        // Get search results using our webSearch function
        let answer;
        try {
          answer = await webSearch(searchQuery);
        } catch (searchError) {
          console.error("Error during search:", searchError);
          answer = "Search failed. Let me continue with what I already know.";
        }
        
        // Check that answer is not empty
        if (!answer || answer.trim() === "") {
          answer = "No search results found. Let me continue with what I already know.";
        }
        
        // Add tool response to session - ensuring tool_call_id matches exactly
        const toolMessage = {
          role: "tool",
          tool_call_id: toolCall.id,
          name: "search_web",
          content: answer
        };
        
        addMessage(sessionId, toolMessage);
        
        // Send tool response back to GPT
        const secondResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: getMessages(sessionId)
        });
        
        const finalAnswer = secondResponse.choices[0].message.content || "";
        
        // Add final response to session
        addMessage(sessionId, { role: "assistant", content: finalAnswer });
        
        // During the questioning phase, return text in the reply field
        return { reply: finalAnswer, tasks: [] };
      } catch (error) {
        console.error("Error handling tool call:", error);
        // Add a backup reply if tool calling fails
        const errorMessage = "I'm having trouble accessing search results right now. Let me help based on what I already know.";
        addMessage(sessionId, { role: "assistant", content: errorMessage });
        return { reply: errorMessage, tasks: [] };
      }
    }

    // Add GPT response to session and return it directly
    const content = responseMessage.content || "";
    addMessage(sessionId, { 
      role: "assistant", 
      content: content
    });
    
    // During the questioning phase, return text in the reply field
    return { reply: content, tasks: [] };
  } 
  // If we have 3 or more user messages, generate tasks with enhanced research
  else {
    // Gather context based on task type
    let researchResults = "";
    
    // For website-related tasks
    if (taskType === "website") {
      if (uniqueUrls.length > 0) {
        try {
          // Use our improved SEO analysis instead of just getting head data
          const seoAnalysis = await analyzeSEOIssues(uniqueUrls[0]);
          
          if (seoAnalysis.success) {
            // Format the SEO issues into a structured report for GPT
            let issuesList = "";
            
            if (seoAnalysis.issues.length > 0) {
              issuesList = "Specific SEO issues found:\n\n";
              seoAnalysis.issues.forEach((issue, index) => {
                issuesList += `${index + 1}. ${issue.type.toUpperCase()} (${issue.severity} severity): ${issue.description}\n`;
              });
            } else {
              issuesList = "No significant SEO issues were found in the head tags, but there may be other improvements possible.";
            }
            
            // Add general site information
            const siteInfo = `
Website: ${seoAnalysis.url}
Title: ${seoAnalysis.title || 'Not specified'}
Meta Description: ${seoAnalysis.headData.metaData.description || 'Not specified'}
Keywords: ${seoAnalysis.headData.metaData.keywords || 'Not specified'}

${issuesList}

When generating tasks, focus on fixing the specific issues mentioned above. 
Create detailed, actionable tasks with clear steps to resolve each issue.
Tasks should have specific titles that mention the exact problem being fixed.
`;
            
            researchResults = siteInfo;
          } else {
            researchResults = "Website analysis could not be completed. I'll provide general SEO recommendations.";
          }
        } catch (error) {
          console.error("Error in detailed SEO analysis:", error);
          researchResults = "Website analysis encountered an error. I'll provide general SEO recommendations.";
        }
      } else {
        // If no URLs were provided but it's a website task
        const userQuery = userMessages.map(msg => msg.content).join(" ");
        try {
          researchResults = await webSearch(`website best practices for ${userQuery}`);
        } catch (error) {
          console.error("Error in general website search:", error);
          researchResults = "I'll provide recommendations based on web development best practices.";
        }
      }
    } 
    // For general tasks (productivity, personal, etc.)
    else {
      // Extract key topics from user messages
      const userTopics = userMessages.map(msg => msg.content).join(" ");
      try {
        researchResults = await webSearch(`best practices for ${userTopics}`);
      } catch (error) {
        console.error("Error in general topic search:", error);
        researchResults = "I'll provide recommendations based on best practices.";
      }
    }
    
    // Add instruction to format response as structured tasks
    const messagesWithFormat = [...messages];
    
    // Add research results as a system message
    if (researchResults) {
      messagesWithFormat.push({
        role: "system",
        content: `Research results to help formulate your tasks: ${researchResults}`
      });
    }
    
    // Add system message to enforce task generation with very explicit formatting instructions
    messagesWithFormat.push({
      role: "system",
      content: "Generate EXACTLY 3 tasks based on our conversation and the website analysis provided. Focus on solving SPECIFIC PROBLEMS that were identified rather than general recommendations. Each task should:\n\n1. Have a title that clearly mentions the specific issue being fixed (e.g., 'Fix Missing Meta Description' rather than 'Improve SEO')\n2. Include a detailed, step-by-step description of how to implement the solution\n3. Mention specific tools, code snippets, or techniques needed\n4. Include a realistic time estimate\n\nYour response must be a valid JSON object with a single 'tasks' property containing an array of 3 task objects. Each task MUST have exactly these fields: 'title', 'description', and 'timeEstimate'. Format example: {\"tasks\":[{\"title\":\"Task 1\",\"description\":\"Description 1\",\"timeEstimate\":\"2 hours\"},{\"title\":\"Task 2\",\"description\":\"Description 2\",\"timeEstimate\":\"3 hours\"},{\"title\":\"Task 3\",\"description\":\"Description 3\",\"timeEstimate\":\"1 hour\"}]}"
    });
    
    // Create appropriate fallback tasks based on task type
    const fallbackTasks = taskType === "website" ? [
      {
        title: "Improve Website SEO",
        description: "Optimize meta tags, headings, and content for better search engine visibility. Ensure title tags and meta descriptions are unique and descriptive for each page. Use heading tags (H1, H2, H3) in a hierarchical structure.",
        timeEstimate: "3 hours"
      },
      {
        title: "Enhance User Experience",
        description: "Improve site navigation and loading speed for better user retention. Compress images, minify CSS/JS, and implement lazy loading. Ensure the site is mobile-friendly and has an intuitive navigation structure.",
        timeEstimate: "4 hours"
      },
      {
        title: "Optimize Conversion Funnel",
        description: "Analyze and improve the user journey to increase sign-ups and conversions. Add clear calls-to-action, simplify forms, and reduce friction in the checkout/signup process. A/B test different elements to identify what works best.",
        timeEstimate: "5 hours"
      }
    ] : [
      {
        title: "Create a Productivity System",
        description: "Establish a personal productivity system using techniques like time blocking, the Pomodoro Technique, or Getting Things Done (GTD). Choose one method, set up the necessary tools (digital or analog), and schedule implementation for your daily routine.",
        timeEstimate: "2 hours"
      },
      {
        title: "Minimize Digital Distractions",
        description: "Reduce interruptions from devices and apps by configuring notification settings, using focus mode, and installing productivity extensions. Set up specific times to check email and messages rather than responding immediately.",
        timeEstimate: "1 hour"
      },
      {
        title: "Implement Regular Reviews",
        description: "Establish a system for daily, weekly and monthly reviews of your tasks and goals. Create templates for each review type, schedule them in your calendar, and use them to continuously refine your approach to work.",
        timeEstimate: "3 hours"
      }
    ];
    
    // Send conversation to GPT to get tasks
    try {
      // Use a try-catch with timeout to prevent long-running requests
      const chatPromise = openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messagesWithFormat,
        response_format: { type: "json_object" }
      });
      
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Request timed out")), 15000)
      );
      
      // Race the API call against the timeout
      const chatCompletion = await Promise.race([chatPromise, timeoutPromise]);

      const responseMessage = chatCompletion.choices[0].message;
      // Remove any whitespace and ensure it's valid JSON
      let content = responseMessage.content?.trim() || "{}";
      
      // Try to properly format the content if it's not already valid JSON
      try {
        // Test parse the content
        JSON.parse(content);
      } catch (parseError) {
        console.log("Received malformed JSON, attempting to fix");
        
        // Remove any backticks, as the model sometimes wraps JSON in code blocks
        content = content.replace(/```json|```/g, '').trim();
        
        // Add wrapping tasks object if it's just an array
        if (content.startsWith('[') && content.endsWith(']')) {
          content = `{"tasks": ${content}}`;
        }
      }
      
      // Add the response to the session
      addMessage(sessionId, { 
        role: "assistant", 
        content: content
      });
      
      // Parse the content
      try {
        const parsedData = JSON.parse(content);
        
        // Extract tasks array from response
        let tasksList = [];
        
        // Check if it's already an array of tasks
        if (Array.isArray(parsedData)) {
          tasksList = parsedData;
        } 
        // If it has a tasks property that is an array
        else if (parsedData.tasks && Array.isArray(parsedData.tasks)) {
          tasksList = parsedData.tasks;
        }
        // If it's a single task object
        else if (parsedData.title && parsedData.description && parsedData.timeEstimate) {
          tasksList = [parsedData];
        }
        
        // If no tasks found or tasks array is empty, check if reply field contains tasks
        if (tasksList.length === 0 && parsedData.reply) {
          console.log("No tasks found in tasks array, checking reply for task content");
          const extractedTasks = extractTasksFromReply(parsedData.reply);
          
          if (extractedTasks && extractedTasks.length > 0) {
            console.log(`Found ${extractedTasks.length} tasks in the reply text`);
            tasksList = extractedTasks;
            
            // If we successfully extracted tasks from the reply, remove the reply
            // to avoid duplicating information
            return { 
              tasks: tasksList.slice(0, 3), // Limit to 3 tasks max
              reply: null 
            };
          }
        }
        
        // Ensure we have exactly 3 tasks
        if (tasksList.length === 0) {
          console.warn("No tasks found in response, using fallbacks");
          return { tasks: fallbackTasks, reply: null };
        }
        
        // Validate each task has the required fields
        const validatedTasks = tasksList.map(task => ({
          title: task.title || "Untitled Task",
          description: task.description || "No description provided",
          timeEstimate: task.timeEstimate || "1 hour"
        })).slice(0, 3);
        
        // If we have fewer than 3 tasks, add generic ones
        while (validatedTasks.length < 3) {
          validatedTasks.push(fallbackTasks[validatedTasks.length - 1]);
        }
        
        // Check if the validated tasks look like questions
        if (detectQuestionsInTasks(validatedTasks)) {
          console.log("Tasks appear to be questions, converting to reply format");
          const questionsAsReply = convertTasksToReply(validatedTasks);
          return { tasks: [], reply: questionsAsReply };
        }
        
        return { tasks: validatedTasks, reply: null };
        
      } catch (error) {
        // JSON parsing failed, use fallback tasks
        console.error("Error parsing tasks JSON:", error);
        return { tasks: fallbackTasks, reply: null };
      }
    } catch (error) {
      console.error("Error generating or parsing tasks:", error);
      return { tasks: fallbackTasks, reply: null };
    }
  }

  // If we somehow got here with a text reply and no tasks, try extracting tasks from the reply
  if (response && response.reply && (!response.tasks || response.tasks.length === 0)) {
    const extractedTasks = extractTasksFromReply(response.reply);
    if (extractedTasks && extractedTasks.length > 0) {
      console.log(`Extracted ${extractedTasks.length} tasks from final reply`);
      response.tasks = extractedTasks.slice(0, 3); // Limit to 3 tasks
      response.reply = null; // Clear reply to avoid duplication
    }
  }
  
  return ensureTasksInTasksArray(response);
}

// Enhance the detectQuestionsInTasks function with better patterns
function detectQuestionsInTasks(tasks) {
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return false;
  
  // Patterns that strongly indicate questions rather than tasks
  const strongQuestionPatterns = [
    /\?$/,                           // Ends with question mark
    /^(what|how|where|when|why|which|who|whom)\b/i,  // Starts with question word
    /\b(do|does|did|is|are|am|can|could|would|should|will|have|has|had)\s+(you|your|we|I)\b/i, // Question structure
    /\btell me\b/i,                  // "Tell me" is often a question
    /\blet me know\b/i               // "Let me know" indicates information request
  ];
  
  // Patterns that indicate task nature (as opposed to questions)
  const taskPatterns = [
    /^(create|build|develop|implement|set up|configure|optimize|improve|fix|add|remove|update|modify)/i, // Action verbs
    /\bstep\s*\d+\b/i,               // Step 1, Step 2, etc.
    /\b(hour|minute|day|week)\b/i,   // Time references
    /\bby\s+(using|implementing|adding|following)/i // Implementation details
  ];
  
  // Count strong question indicators
  const questionCount = tasks.filter(task => 
    strongQuestionPatterns.some(pattern => pattern.test(task.title))
  ).length;
  
  // Count task indicators
  const taskCount = tasks.filter(task => 
    taskPatterns.some(pattern => pattern.test(task.title) || 
                     (task.description && pattern.test(task.description)))
  ).length;
  
  // Special check for direct user queries that don't have question marks
  const userQueryCount = tasks.filter(task => {
    const lowercaseTitle = task.title.toLowerCase();
    
    // Check if the title looks like collecting info from the user
    return (lowercaseTitle.includes("your") || lowercaseTitle.includes("you ")) && 
           !lowercaseTitle.includes("should") &&  // Filter out recommendations
           task.description.length < 20;  // Short or empty descriptions are typical for questions
  }).length;
  
  // Combine direct queries with question count
  const totalQuestionIndicators = questionCount + userQueryCount;
  
  // Decision logic:
  // 1. If there are more question indicators than task indicators, it's likely a questionnaire
  // 2. If majority of items (>50%) have question indicators, it's likely a questionnaire
  // 3. If all items are short with minimal description, it's likely a questionnaire
  
  const isQuestionnaire = 
    (totalQuestionIndicators > taskCount) || 
    (totalQuestionIndicators >= Math.ceil(tasks.length / 2)) ||
    (tasks.every(task => task.description.length < 30) && totalQuestionIndicators > 0);
  
  return isQuestionnaire;
}

// Improve the convertTasksToReply function for better formatting
function convertTasksToReply(tasks) {
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return "";
  
  // Format the questions as a conversational reply
  let reply = "Before I can provide specific tasks, I need to understand more about your situation:\n\n";
  
  tasks.forEach((task, index) => {
    // Add question mark if missing and it looks like a question
    let title = task.title;
    if (!title.endsWith("?") && 
        !title.endsWith(".") && 
        !title.endsWith("!") &&
        !/^(create|implement|build|develop|improve)/i.test(title)) {
      title += "?";
    }
    
    reply += `${index + 1}. ${title}\n`;
    
    if (task.description && task.description.trim()) {
      reply += `   ${task.description.trim()}\n`;
    }
    
    if (index < tasks.length - 1) {
      reply += "\n";
    }
  });
  
  return reply + "\n\nOnce you provide this information, I'll be able to suggest specific, tailored tasks for you.";
}

// Update the ensureTasksInTasksArray function to detect and handle questions
function ensureTasksInTasksArray(response) {
  // If there's no response, return null
  if (!response) return null;
  
  // First, handle the case where questions are in the tasks array
  if (response.tasks && response.tasks.length > 0) {
    // Check if the tasks look like questions
    if (detectQuestionsInTasks(response.tasks)) {
      console.log("Detected questions in tasks array, converting to reply");
      
      // Convert the tasks to a reply
      const questionsAsReply = convertTasksToReply(response.tasks);
      
      // Return a new response with the questions as reply and empty tasks
      return {
        sessionId: response.sessionId,
        reply: questionsAsReply,
        tasks: []
      };
    }
  }
  
  // Then handle the usual case where tasks might be in the reply
  if (response.reply) {
    const extractedTasks = extractTasksFromReply(response.reply);
    
    if (extractedTasks && extractedTasks.length > 0) {
      // Check if the extracted tasks look like questions
      if (detectQuestionsInTasks(extractedTasks)) {
        console.log("Extracted content looks like questions, keeping in reply format");
        // Keep the reply as is, don't convert to tasks
        return response;
      }
      
      console.log(`Extracted ${extractedTasks.length} tasks from reply`);
      
      // If we already have tasks, merge them with preference to the extracted ones
      if (response.tasks && response.tasks.length > 0) {
        // Take as many extracted tasks as we can up to 3 total
        const remainingSlots = 3 - response.tasks.length;
        if (remainingSlots > 0) {
          response.tasks = [...response.tasks, ...extractedTasks.slice(0, remainingSlots)];
        }
      } else {
        // If no existing tasks, use the extracted ones
        response.tasks = extractedTasks.slice(0, 3); // Limit to 3 tasks
      }
      
      // Always clear the reply to avoid duplication
      response.reply = null;
    }
  }
  
  // Default to empty tasks array if none exist
  if (!response.tasks) {
    response.tasks = [];
  }
  
  // Force reply to null if tasks are present and don't look like questions
  if (response.tasks.length > 0 && !detectQuestionsInTasks(response.tasks)) {
    response.reply = null;
  }
  
  return response;
}

app.listen(PORT, () => {
  console.log(`🚀 Task Assistant API running on http://localhost:${PORT}`);
});
