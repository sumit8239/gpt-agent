// A simple in-memory storage for chat sessions
const sessions = new Map();

// Create a new session or get existing one
export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [
        {
          role: "system",
          content: "You are an AI assistant specializing in task creation and website analysis. You can help with two main types of requests:\n\n1) **General Task Creation**: If the user wants help with personal productivity, business processes, or any non-website task, gather relevant information about their goals, current situation, and constraints. After sufficient context (2-3 exchanges), generate 3 specific, actionable tasks with clear titles, detailed step-by-step descriptions, and realistic time estimates.\n\n2) **Website Analysis & Improvement**: If the user mentions a website or web-related tasks (SEO, conversions, UX, marketing, etc.), focus on gathering: a) The website URL, b) Their specific goals, c) Their target audience. When a website URL is provided, use available analysis data about it. After gathering context, generate 3 specific, data-driven tasks related to their website goals.\n\nKeep your initial questions brief and direct. For all task types, ensure they are immediately actionable, specific to the user's situation, and provide clear value. Each task should include a title, description, and time estimate."
        }
      ],
      taskType: null // Will store 'general' or 'website' based on initial conversation
    });
  }
  return sessions.get(sessionId);
}

// Add a message to the session
export function addMessage(sessionId, message) {
  const session = getSession(sessionId);
  
  // Validate message before adding to ensure no null content
  const validatedMessage = { ...message };
  
  // Ensure content is not null/undefined for roles that require content
  if ((message.role === "user" || message.role === "assistant" || message.role === "system") 
      && (message.content === null || message.content === undefined)) {
    validatedMessage.content = "";
  }
  
  // Ensure content is not null/undefined for tool messages
  if (message.role === "tool" && (message.content === null || message.content === undefined)) {
    validatedMessage.content = "";
  }
  
  // Attempt to detect task type from user messages if not already set
  if (session.taskType === null && message.role === "user") {
    const content = message.content.toLowerCase();
    
    // Check if it seems to be website-related
    if (content.includes("website") || content.includes("seo") || 
        content.includes("conversion") || content.includes("ux") || 
        content.includes("marketing") || content.includes("url") ||
        content.includes("traffic") || content.includes("landing page") ||
        /https?:\/\/[^\s]+/.test(content)) {
      session.taskType = "website";
    } else {
      session.taskType = "general";
    }
  }
  
  session.messages.push(validatedMessage);
  return session;
}

// Get all messages for a session
export function getMessages(sessionId) {
  return getSession(sessionId).messages;
}

// Get the detected task type for a session
export function getTaskType(sessionId) {
  return getSession(sessionId).taskType;
}

// Clear a session
export function clearSession(sessionId) {
  sessions.delete(sessionId);
} 