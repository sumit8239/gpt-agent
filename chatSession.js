// A simple in-memory storage for chat sessions
const sessions = new Map();

// Create a new session or get existing one
export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [
        {
          role: "system",
          content: "You are an AI assistant specializing in task creation for any domain. Your goal is to help users break down complex goals into actionable tasks. Follow this process:\n\n1) Ask targeted clarifying questions to understand the user's specific needs. Focus on their goals and challenges. Keep questions brief and direct.\n\n2) After gathering basic information, generate EXACTLY 3 specific, actionable tasks that directly address the user's goal.\n\n3) Each task must include: (a) A clear, specific title describing what needs to be done (b) A detailed description with step-by-step instructions (c) A realistic time estimate.\n\nMake all tasks immediately actionable, specific to the user's situation, and provide clear value."
        }
      ],
      taskType: null, // Will store task category based on conversation
      questionCount: 0, // Track how many questions have been asked
      hasEnoughContext: false, // Flag to indicate when ready for task generation
      tasksGenerated: false, // Flag to indicate if tasks have been generated
      taskEditRequested: false, // Flag to indicate if user requested to edit tasks
      websiteData: null, // Will store website analysis data if relevant
      specificTaskEditing: null // Will store which specific task to edit (index)
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
    
    // Check for different domains to categorize the task type
    if (content.includes("website") || content.includes("seo") || 
        content.includes("web") || content.includes("url") ||
        /https?:\/\/[^\s]+/.test(content)) {
      session.taskType = "website";
    } else if (content.includes("business") || content.includes("company") ||
               content.includes("startup") || content.includes("product") ||
               content.includes("market") || content.includes("customer")) {
      session.taskType = "business";
    } else if (content.includes("learn") || content.includes("study") ||
               content.includes("education") || content.includes("course")) {
      session.taskType = "education";
    } else if (content.includes("personal") || content.includes("life") ||
               content.includes("habit") || content.includes("goal")) {
      session.taskType = "personal";
    } else {
      session.taskType = "general";
    }
  }
  
  // Check for immediate task generation keywords in user messages
  if (message.role === "user") {
    const content = message.content.toLowerCase();
    const immediateTaskTriggers = [
      "generate task", "create task", "make task", 
      "give me task", "generate new task", "create new task",
      "i need task", "generate a plan", "create a plan",
      "make a plan", "create steps", "generate steps"
    ];
    
    if (immediateTaskTriggers.some(trigger => content.includes(trigger))) {
      session.hasEnoughContext = true;
    }
    
    // Check for task editing requests
    const editTaskTriggers = [
      "edit task", "modify task", "change task", 
      "update task", "revise task", "fix task"
    ];
    
    if (editTaskTriggers.some(trigger => content.includes(trigger))) {
      session.taskEditRequested = true;
      
      // Check if a specific task number is mentioned
      const taskNumberMatch = content.match(/task\s*(\d+)|(\d+)(st|nd|rd|th)\s*task/i);
      if (taskNumberMatch) {
        const taskNum = parseInt(taskNumberMatch[1] || taskNumberMatch[2], 10);
        if (taskNum > 0 && taskNum <= 3) {
          session.specificTaskEditing = taskNum - 1; // Convert to 0-indexed
        }
      }
    }
  }
  
  // Track assistant questions for conversational flow
  if (message.role === "assistant" && 
      (message.content.endsWith("?") || 
       message.content.includes("Could you") || 
       message.content.includes("Can you"))) {
    session.questionCount += 1;
  }
  
  // Dynamic contextual understanding - determine if we have enough context
  // based on message quality and quantity
  const userMessages = session.messages.filter(msg => msg.role === "user");
  
  // Check if the most recent user message is detailed enough (more than 100 characters)
  const lastUserMessage = userMessages.length > 0 ? 
    userMessages[userMessages.length - 1].content : "";
  const isDetailedMessage = lastUserMessage.length > 100;
  
  // Check if we have multiple messages already
  const hasMultipleMessages = userMessages.length >= 2;
  
  // Check if we exceeded the max question limit
  const reachedMaxQuestions = session.questionCount >= 3;
  
  // Determine if we have enough context based on these factors
  if (isDetailedMessage || hasMultipleMessages || reachedMaxQuestions) {
    session.hasEnoughContext = true;
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

// Check if we have enough context for task generation
export function isReadyForTasks(sessionId) {
  return getSession(sessionId).hasEnoughContext;
}

// Mark that tasks have been generated
export function markTasksGenerated(sessionId) {
  const session = getSession(sessionId);
  session.tasksGenerated = true;
}

// Check if tasks have been generated already
export function hasGeneratedTasks(sessionId) {
  return getSession(sessionId).tasksGenerated === true;
}

// Check if user requested task editing
export function isTaskEditRequested(sessionId) {
  return getSession(sessionId).taskEditRequested === true;
}

// Get specific task to edit (null if all tasks)
export function getSpecificTaskToEdit(sessionId) {
  return getSession(sessionId).specificTaskEditing;
}

// Mark task edit request as handled
export function clearTaskEditRequest(sessionId) {
  const session = getSession(sessionId);
  session.taskEditRequested = false;
  session.specificTaskEditing = null;
}

// Store website analysis data
export function storeWebsiteData(sessionId, data) {
  const session = getSession(sessionId);
  session.websiteData = data;
}

// Get stored website data
export function getWebsiteData(sessionId) {
  return getSession(sessionId).websiteData;
}

// Reset the question counter
export function resetQuestionCount(sessionId) {
  getSession(sessionId).questionCount = 0;
}

// Clear a session
export function clearSession(sessionId) {
  sessions.delete(sessionId);
} 