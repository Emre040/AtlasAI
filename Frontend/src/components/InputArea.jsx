export function InputArea({ inputRef, inputValue, setInputValue, handleSend, isLoading }) {
    return (
        <div className="HPAG-input-area">
            <input
                ref={inputRef}
                type="text"
                className="HPAG-input"
                placeholder="Ask your Human Protein Atlas Agent..."
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                disabled={isLoading}
            />
            <button className="HPAG-send-btn" onClick={handleSend} disabled={isLoading}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                    <path d="M15.854 7.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708-.708L14.293 8.5H.5a.5.5 0 0 1 0-1h13.793L8.146 1.354a.5.5 0 1 1 .708-.708l7 7z"/>
                </svg>
            </button>
        </div>
    );
}
